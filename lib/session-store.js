const { neon } = require("@neondatabase/serverless");

const SNAPSHOT_BUCKET_MS = 30 * 1000;
const HISTORY_WINDOW_MINUTES = 90;
const MAX_RECENT_SNAPSHOTS = 240;

let schemaPromise = null;

function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getSql() {
  if (!databaseConfigured()) return null;
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema(sql) {
  if (!schemaPromise) {
    schemaPromise = sql.transaction([
      sql`
        CREATE TABLE IF NOT EXISTS market_snapshots (
          id BIGSERIAL PRIMARY KEY,
          session_date DATE NOT NULL,
          instrument_key TEXT NOT NULL,
          expiry_date DATE NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL,
          bucket_at TIMESTAMPTZ NOT NULL,
          source TEXT NOT NULL,
          spot DOUBLE PRECISION NOT NULL DEFAULT 0,
          atm_strike DOUBLE PRECISION NOT NULL DEFAULT 0,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (session_date, instrument_key, expiry_date, bucket_at)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS market_snapshots_lookup_idx
        ON market_snapshots (session_date, instrument_key, expiry_date, captured_at)
      `
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function saveMarketSnapshot(payload) {
  if (!databaseConfigured()) {
    return { configured: false, saved: false, reason: "DATABASE_URL missing" };
  }
  if (!payload || payload.source !== "live" || !Array.isArray(payload.data) || !payload.data.length) {
    return { configured: true, saved: false, reason: "Live market payload required" };
  }

  const capturedAt = new Date(payload.generatedAt || Date.now());
  if (!isMarketSession(capturedAt)) {
    return { configured: true, saved: false, reason: "Outside NSE/BSE cash session" };
  }

  const sql = getSql();
  await ensureSchema(sql);
  const sessionDate = istDate(capturedAt);
  const bucketAt = new Date(Math.floor(capturedAt.getTime() / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS);
  const compactPayload = compactSnapshotPayload(payload);
  const spot = number(compactPayload.underlying && compactPayload.underlying.spot);
  const atmStrike = closestStrike(compactPayload.data, spot);

  const rows = await sql`
    INSERT INTO market_snapshots (
      session_date, instrument_key, expiry_date, captured_at, bucket_at,
      source, spot, atm_strike, payload
    ) VALUES (
      ${sessionDate}, ${payload.instrumentKey}, ${payload.expiry}, ${capturedAt.toISOString()},
      ${bucketAt.toISOString()}, ${payload.source}, ${spot}, ${atmStrike}, ${JSON.stringify(compactPayload)}::jsonb
    )
    ON CONFLICT (session_date, instrument_key, expiry_date, bucket_at)
    DO UPDATE SET
      captured_at = EXCLUDED.captured_at,
      spot = EXCLUDED.spot,
      atm_strike = EXCLUDED.atm_strike,
      payload = EXCLUDED.payload
    RETURNING captured_at, (xmax = 0) AS inserted
  `;

  return {
    configured: true,
    saved: true,
    inserted: Boolean(rows[0] && rows[0].inserted),
    capturedAt: rows[0] ? rows[0].captured_at : capturedAt.toISOString(),
    sessionDate
  };
}

async function loadSessionHistory(instrumentKey, expiryDate, at = new Date()) {
  if (!databaseConfigured()) {
    return emptyHistory("DATABASE_URL missing");
  }

  const sql = getSql();
  await ensureSchema(sql);
  const sessionDate = istDate(at);
  const [firstRows, recentRows, statsRows] = await sql.transaction([
    sql`
      SELECT captured_at, payload
      FROM market_snapshots
      WHERE session_date = ${sessionDate}
        AND instrument_key = ${instrumentKey}
        AND expiry_date = ${expiryDate}
      ORDER BY captured_at ASC
      LIMIT 1
    `,
    sql`
      SELECT captured_at, payload
      FROM market_snapshots
      WHERE session_date = ${sessionDate}
        AND instrument_key = ${instrumentKey}
        AND expiry_date = ${expiryDate}
      ORDER BY captured_at DESC
      LIMIT ${MAX_RECENT_SNAPSHOTS}
    `,
    sql`
      SELECT COUNT(*)::int AS snapshot_count,
             MIN(captured_at) AS first_saved_at,
             MAX(captured_at) AS last_saved_at
      FROM market_snapshots
      WHERE session_date = ${sessionDate}
        AND instrument_key = ${instrumentKey}
        AND expiry_date = ${expiryDate}
    `
  ], { readOnly: true });

  const snapshots = dedupePayloads([
    ...firstRows,
    ...recentRows.reverse()
  ]);
  const stats = statsRows[0] || {};
  return {
    configured: true,
    sessionDate,
    snapshots,
    snapshotCount: number(stats.snapshot_count),
    firstSavedAt: stats.first_saved_at || null,
    lastSavedAt: stats.last_saved_at || null,
    historyWindowMinutes: HISTORY_WINDOW_MINUTES
  };
}

function compactSnapshotPayload(payload) {
  return {
    source: payload.source,
    generatedAt: payload.generatedAt,
    instrumentKey: payload.instrumentKey,
    expiry: payload.expiry,
    underlying: {
      spot: number(payload.underlying && payload.underlying.spot),
      dayOpen: 0
    },
    data: payload.data.map((row) => ({
      strike_price: number(row.strike_price || row.strikePrice || row.strike),
      underlying_spot_price: number(row.underlying_spot_price || row.underlyingSpotPrice || row.underlying_spot),
      pcr: number(row.pcr),
      call_options: compactSide(row.call_options || row.callOption || row.ce || row.CE),
      put_options: compactSide(row.put_options || row.putOption || row.pe || row.PE)
    }))
  };
}

function compactSide(side = {}) {
  const market = side.market_data || side.marketData || side.market || side;
  const greeks = side.option_greeks || side.optionGreeks || side.greeks || {};
  return {
    instrument_key: side.instrument_key || side.instrumentKey || "",
    market_data: {
      ltp: number(market.ltp || market.last_price || market.lastPrice),
      volume: number(market.volume),
      oi: number(market.oi || market.open_interest || market.openInterest),
      prev_oi: number(market.prev_oi || market.prevOi || market.previous_oi || market.previousOpenInterest),
      bid_price: number(market.bid_price || market.bidPrice || market.bid),
      ask_price: number(market.ask_price || market.askPrice || market.ask),
      bid_qty: number(market.bid_qty || market.bidQty || market.bid_quantity),
      ask_qty: number(market.ask_qty || market.askQty || market.ask_quantity)
    },
    option_greeks: {
      delta: number(greeks.delta),
      gamma: number(greeks.gamma),
      theta: number(greeks.theta),
      vega: number(greeks.vega),
      iv: number(greeks.iv)
    }
  };
}

function isMarketSession(date) {
  const parts = istParts(date);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minute = parts.hour * 60 + parts.minute;
  return minute >= 9 * 60 + 15 && minute <= 15 * 60 + 30;
}

function istDate(date) {
  const parts = istParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function istParts(date) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday
  };
}

function dedupePayloads(rows) {
  const byTime = new Map();
  rows.forEach((row) => {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (!payload) return;
    payload.generatedAt = new Date(row.captured_at || payload.generatedAt).toISOString();
    byTime.set(payload.generatedAt, payload);
  });
  return [...byTime.values()].sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt));
}

function closestStrike(rows, spot) {
  return rows.reduce((best, row) => {
    const strike = number(row.strike_price || row.strikePrice || row.strike);
    if (!best || Math.abs(strike - spot) < Math.abs(best - spot)) return strike;
    return best;
  }, 0);
}

function emptyHistory(reason) {
  return {
    configured: false,
    reason,
    snapshots: [],
    snapshotCount: 0,
    firstSavedAt: null,
    lastSavedAt: null,
    historyWindowMinutes: HISTORY_WINDOW_MINUTES
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  databaseConfigured,
  isMarketSession,
  loadSessionHistory,
  saveMarketSnapshot
};
