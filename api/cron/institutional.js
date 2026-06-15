const { databaseConfigured } = require("../../lib/institutional-store");
const { syncInstitutionalHistory } = require("../../lib/institutional-sync");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  const secret = process.env.CRON_SECRET || "";
  const authorization = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!secret || authorization !== `Bearer ${secret}`) return sendJson(res, 401, { error: "Unauthorized institutional sync" });
  if (!databaseConfigured()) return sendJson(res, 500, { error: "DATABASE_URL missing" });
  try {
    const result = await syncInstitutionalHistory({ lookbackDays: 45 });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: error.message || "Institutional sync failed" });
  }
};

function setJsonHeaders(res) {
  if (typeof res.setHeader === "function") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}

function sendJson(res, statusCode, payload) {
  if (typeof res.status === "function" && typeof res.json === "function") return res.status(statusCode).json(payload);
  res.statusCode = statusCode;
  return res.end(JSON.stringify(payload));
}
