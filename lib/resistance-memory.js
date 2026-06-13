const LOOKBACK_SESSIONS = 5;

function buildResistanceMemory(sessions, options = {}) {
  const normalized = (Array.isArray(sessions) ? sessions : [])
    .map(normalizeSession)
    .filter((session) => session.candles.length && session.closingRows.length)
    .slice(0, LOOKBACK_SESSIONS);
  if (!normalized.length) return null;

  const spot = number(options.spot) || normalized[0].closeSpot;
  const step = inferStrikeStep(normalized[0].closingRows);
  const strikes = normalized[0].closingRows
    .map((row) => row.strike)
    .filter((strike) => strike >= spot && strike <= spot + step * 11);
  const candidates = strikes.map((level) => resistanceEvidence(normalized, level, step))
    .filter((candidate) => candidate.testedSessions > 0 && candidate.acceptedBreakSessions === 0)
    .sort((a, b) => (
      a.acceptedBreakSessions - b.acceptedBreakSessions
      || b.testedSessions - a.testedSessions
      || b.totalTests - a.totalTests
      || b.lastTestTime - a.lastTestTime
      || Math.abs(a.level - spot) - Math.abs(b.level - spot)
    ));
  const resistance = candidates[0];
  if (!resistance) return null;

  const currentExpiry = String(options.currentExpiry || "");
  const sameExpiryClose = options.sameExpiryClose
    ? normalizeExpiryClose(options.sameExpiryClose, resistance.level)
    : null;
  return {
    formulaVersion: "five-session-resistance-v1",
    lookbackSessions: normalized.length,
    level: resistance.level,
    step,
    testedSessions: resistance.testedSessions,
    defendedSessions: resistance.defendedSessions,
    acceptedBreakSessions: resistance.acceptedBreakSessions,
    totalTests: resistance.totalTests,
    lastTestDate: resistance.lastTestDate,
    sessionEvidence: resistance.sessionEvidence,
    candidateCount: candidates.length,
    currentExpiry,
    expiryContinuity: sameExpiryClose && sameExpiryClose.expiry === currentExpiry ? "same-expiry" : "expiry-reset",
    sameExpiryPreviousClose: sameExpiryClose
  };
}

function resistanceEvidence(sessions, level, step) {
  const sessionEvidence = sessions.map((session) => analyzeSessionLevel(session, level, step));
  const tested = sessionEvidence.filter((item) => item.tests > 0);
  return {
    level,
    testedSessions: tested.length,
    defendedSessions: tested.filter((item) => item.defended).length,
    acceptedBreakSessions: sessionEvidence.filter((item) => item.acceptedBreak).length,
    totalTests: tested.reduce((total, item) => total + item.tests, 0),
    lastTestDate: tested.length ? tested[0].date : null,
    lastTestTime: tested.length ? tested[0].lastTestTime : 0,
    sessionEvidence
  };
}

function analyzeSessionLevel(session, level, step) {
  const candles = session.candles;
  const approachFloor = level - step / 2;
  let tests = 0;
  let inTest = false;
  let lastTestTime = 0;
  let singleCloseAbove = false;
  let acceptedBreak = false;
  let rejectedBreak = false;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = index ? candles[index - 1].close : candle.open;
    const approachedFromBelow = previousClose <= level && candle.high >= approachFloor;
    if (approachedFromBelow && !inTest) {
      tests += 1;
      lastTestTime = candle.start;
      inTest = true;
    }
    if (candle.high < approachFloor) inTest = false;
    if (candle.close > level) {
      singleCloseAbove = true;
      if (index && candles[index - 1].close > level) acceptedBreak = true;
    } else if (singleCloseAbove) {
      rejectedBreak = true;
    }
  }
  return {
    date: session.sessionDate,
    expiry: session.expiryDate,
    tests,
    defended: tests > 0 && !acceptedBreak && session.closeSpot <= level,
    acceptedBreak,
    rejectedBreak: rejectedBreak && !acceptedBreak,
    lastTestTime,
    high: Math.max(...candles.map((candle) => candle.high)),
    close: session.closeSpot
  };
}

function normalizeSession(session) {
  const snapshots = Array.isArray(session.snapshots) ? session.snapshots : [];
  const closing = snapshots[snapshots.length - 1] || null;
  return {
    sessionDate: String(session.sessionDate || ""),
    expiryDate: String(session.expiryDate || ""),
    candles: (session.candles5m || []).map(normalizeCandle).filter((candle) => candle.close > 0).sort((a, b) => a.start - b.start),
    closeSpot: closing ? snapshotSpot(closing) : number(session.closeSpot),
    closingRows: closing ? normalizeRows(closing.data || []) : []
  };
}

function normalizeExpiryClose(entry, strike) {
  const payload = entry.payload || entry;
  const row = normalizeRows(payload.data || []).find((item) => item.strike === strike);
  if (!row) return null;
  return {
    sessionDate: String(entry.sessionDate || entry.session_date || ""),
    expiry: String(entry.expiryDate || entry.expiry_date || payload.expiry || ""),
    capturedAt: entry.capturedAt || entry.captured_at || payload.generatedAt || null,
    ceOi: row.ce.oi,
    ceMid: row.ce.mid
  };
}

function normalizeCandle(candle) {
  if (Array.isArray(candle)) {
    return { start: new Date(candle[0]).getTime(), open: number(candle[1]), high: number(candle[2]), low: number(candle[3]), close: number(candle[4]) };
  }
  return {
    start: new Date(candle.start || candle.candle_at).getTime(),
    open: number(candle.open),
    high: number(candle.high),
    low: number(candle.low),
    close: number(candle.close)
  };
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const ce = row.call_options || row.callOption || row.ce || {};
    const market = ce.market_data || ce.marketData || ce.market || ce;
    return {
      strike: number(row.strike_price || row.strikePrice || row.strike),
      ce: {
        oi: number(market.oi || market.open_interest || market.openInterest),
        mid: midpoint(market)
      }
    };
  }).filter((row) => row.strike > 0).sort((a, b) => a.strike - b.strike);
}

function midpoint(market) {
  const bid = number(market.bid_price || market.bidPrice || market.bid);
  const ask = number(market.ask_price || market.askPrice || market.ask);
  return bid && ask ? (bid + ask) / 2 : number(market.ltp || market.last_price || market.lastPrice);
}

function snapshotSpot(payload) {
  const underlying = payload.underlying || {};
  return number(underlying.spot) || number((payload.data || [])[0] && (payload.data || [])[0].underlying_spot_price);
}

function inferStrikeStep(rows) {
  const differences = rows.slice(1).map((row, index) => row.strike - rows[index].strike).filter((value) => value > 0);
  return median(differences) || 50;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  LOOKBACK_SESSIONS,
  analyzeSessionLevel,
  buildResistanceMemory
};
