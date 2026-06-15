const { buildInstitutionalResearch } = require("../../lib/institutional-research");
const { databaseConfigured, loadInstitutionalHistory } = require("../../lib/institutional-store");
const { syncInstitutionalHistory } = require("../../lib/institutional-sync");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  if (!databaseConfigured()) {
    return sendJson(res, 200, { configured: false, ready: false, reason: "DATABASE_URL missing" });
  }
  try {
    let records = await loadInstitutionalHistory(21);
    if (!records.length || shouldRefresh(records[records.length - 1].tradeDate)) {
      await syncInstitutionalHistory({ lookbackDays: records.length ? 8 : 30 });
      records = await loadInstitutionalHistory(21);
    }
    const research = buildInstitutionalResearch(records);
    return sendJson(res, 200, { configured: true, ready: research.ready, research });
  } catch (error) {
    return sendJson(res, 500, { configured: true, ready: false, error: error.message || "Institutional research unavailable" });
  }
};

function shouldRefresh(latestDate) {
  const now = new Date();
  const istHour = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return istHour >= 19 && latestDate !== today;
}

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
