const {
  databaseConfigured,
  loadLatestCompletedSession,
  loadPriorSessionPlaybooks,
  saveSessionPlaybook
} = require("../../lib/session-store");
const { FORMULA_VERSION, buildSessionPlaybook } = require("../../lib/session-playbook");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  const query = req.query || {};
  const instrumentKey = String(query.instrument_key || "NSE_INDEX|Nifty 50");
  if (!databaseConfigured()) {
    return sendJson(res, 200, { configured: false, ready: false, reason: "DATABASE_URL missing" });
  }

  try {
    const session = await loadLatestCompletedSession(instrumentKey);
    if (!session) {
      return sendJson(res, 200, {
        configured: true,
        ready: false,
        reason: "No completed DB session is available yet"
      });
    }
    const prior = await loadPriorSessionPlaybooks(
      instrumentKey,
      session.sessionDate,
      FORMULA_VERSION,
      30
    );
    const playbook = buildSessionPlaybook(session, prior);
    if (playbook.dataQuality.status === "COMPLETE") {
      await saveSessionPlaybook(playbook);
    }
    return sendJson(res, 200, { configured: true, ready: true, playbook });
  } catch (error) {
    return sendJson(res, 500, {
      configured: true,
      ready: false,
      error: error.message || "Unable to build the session playbook"
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
