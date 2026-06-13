const {
  databaseConfigured,
  loadLatestExpiryClose,
  loadRecentCompletedSessions
} = require("../../lib/session-store");
const { buildResistanceMemory } = require("../../lib/resistance-memory");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  const query = req.query || {};
  const instrumentKey = String(query.instrument_key || "NSE_INDEX|Nifty 50");
  const expiryDate = String(query.expiry_date || "");
  const spot = Number(query.spot) || 0;
  if (!databaseConfigured()) {
    return sendJson(res, 200, { configured: false, ready: false, reason: "DATABASE_URL missing" });
  }
  if (!expiryDate || expiryDate === "auto" || !spot) {
    return sendJson(res, 400, { configured: true, ready: false, reason: "Resolved expiry and current spot are required" });
  }

  try {
    const [sessions, sameExpiryClose] = await Promise.all([
      loadRecentCompletedSessions(instrumentKey, 5),
      loadLatestExpiryClose(instrumentKey, expiryDate)
    ]);
    const memory = buildResistanceMemory(sessions, {
      spot,
      currentExpiry: expiryDate,
      sameExpiryClose
    });
    return sendJson(res, 200, {
      configured: true,
      ready: Boolean(memory),
      reason: memory ? "" : "No tested five-session resistance is available above current spot",
      memory
    });
  } catch (error) {
    return sendJson(res, 500, {
      configured: true,
      ready: false,
      error: error.message || "Unable to build five-session resistance memory"
    });
  }
};

function setJsonHeaders(res) {
  if (typeof res.setHeader === "function") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}

function sendJson(res, statusCode, payload) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(statusCode).json(payload);
  }
  res.statusCode = statusCode;
  return res.end(JSON.stringify(payload));
}
