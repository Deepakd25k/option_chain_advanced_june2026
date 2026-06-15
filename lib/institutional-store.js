const { neon } = require("@neondatabase/serverless");

let schemaPromise = null;

function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getSql() {
  return databaseConfigured() ? neon(process.env.DATABASE_URL) : null;
}

async function ensureInstitutionalSchema(sql) {
  if (!schemaPromise) {
    schemaPromise = sql.transaction([
      sql`
        CREATE TABLE IF NOT EXISTS institutional_daily (
          trade_date DATE PRIMARY KEY,
          verified BOOLEAN NOT NULL DEFAULT FALSE,
          participant_report JSONB NOT NULL,
          cash_report JSONB,
          source JSONB NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS institutional_daily_date_idx
        ON institutional_daily (trade_date DESC)
      `
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function saveInstitutionalRecord(record) {
  if (!databaseConfigured()) return { configured: false, saved: false, reason: "DATABASE_URL missing" };
  const sql = getSql();
  await ensureInstitutionalSchema(sql);
  await sql`
    INSERT INTO institutional_daily (trade_date, verified, participant_report, cash_report, source)
    VALUES (
      ${record.tradeDate}, ${Boolean(record.verified)}, ${JSON.stringify(record.participants)}::jsonb,
      ${record.cash ? JSON.stringify(record.cash) : null}::jsonb, ${JSON.stringify(record.source || {})}::jsonb
    )
    ON CONFLICT (trade_date)
    DO UPDATE SET
      verified = EXCLUDED.verified,
      participant_report = EXCLUDED.participant_report,
      cash_report = COALESCE(EXCLUDED.cash_report, institutional_daily.cash_report),
      source = EXCLUDED.source,
      updated_at = NOW()
  `;
  return { configured: true, saved: true, tradeDate: record.tradeDate };
}

async function attachCashReport(cash) {
  if (!databaseConfigured() || !cash || !cash.date) return { saved: false };
  const sql = getSql();
  await ensureInstitutionalSchema(sql);
  const rows = await sql`
    UPDATE institutional_daily
    SET cash_report = ${JSON.stringify(cash)}::jsonb,
        updated_at = NOW()
    WHERE trade_date = ${cash.date}
    RETURNING trade_date
  `;
  return { saved: Boolean(rows.length), tradeDate: cash.date };
}

async function loadInstitutionalHistory(limit = 21) {
  if (!databaseConfigured()) return [];
  const sql = getSql();
  await ensureInstitutionalSchema(sql);
  const rows = await sql`
    SELECT trade_date, verified, participant_report, cash_report, source, fetched_at, updated_at
    FROM institutional_daily
    ORDER BY trade_date DESC
    LIMIT ${Math.max(1, Math.min(80, Number(limit) || 21))}
  `;
  return rows.reverse().map((row) => {
    const participants = row.participant_report || {};
    return {
      tradeDate: dateOnly(row.trade_date),
      verified: Boolean(row.verified),
      fii: participants.FII || participants.fii,
      participants,
      cash: row.cash_report || null,
      source: row.source || {},
      fetchedAt: row.fetched_at,
      updatedAt: row.updated_at
    };
  });
}

async function loadStoredInstitutionalDates(days = 60) {
  if (!databaseConfigured()) return new Set();
  const sql = getSql();
  await ensureInstitutionalSchema(sql);
  const rows = await sql`
    SELECT trade_date
    FROM institutional_daily
    WHERE trade_date >= CURRENT_DATE - ${Math.max(1, Math.min(180, days))}::int
  `;
  return new Set(rows.map((row) => dateOnly(row.trade_date)));
}

function dateOnly(value) {
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

module.exports = {
  attachCashReport,
  databaseConfigured,
  loadInstitutionalHistory,
  loadStoredInstitutionalDates,
  saveInstitutionalRecord
};
