const { loadSessionHistory } = require("../../lib/session-store");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  const query = req.query || {};
  const instrumentKey = String(query.instrument_key || "NSE_INDEX|Nifty 50");
  const expiryDate = String(query.expiry_date || "");

  if (!expiryDate || expiryDate === "auto") {
    return sendJson(res, 400, { error: "A resolved expiry_date is required" });
  }

  try {
    const history = await loadSessionHistory(instrumentKey, expiryDate);
    return sendJson(res, 200, history);
  } catch (error) {
    return sendJson(res, 500, {
      configured: Boolean(process.env.DATABASE_URL),
      error: error.message || "Unable to load session history",
      snapshots: []
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
