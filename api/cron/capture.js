const optionChainApi = require("../upstox/option-chain");
const { isMarketSession, saveMarketSnapshot } = require("../../lib/session-store");

const DEFAULT_INSTRUMENTS = [
  "NSE_INDEX|Nifty 50",
  "NSE_INDEX|Nifty Bank",
  "NSE_INDEX|Nifty Fin Service",
  "BSE_INDEX|SENSEX"
];

module.exports = async function handler(req, res) {
  setJsonHeaders(res);
  const cronSecret = process.env.CRON_SECRET || "";
  const authorization = req.headers && (req.headers.authorization || req.headers.Authorization);

  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return sendJson(res, 401, { error: "Unauthorized recorder request" });
  }
  if (!isMarketSession(new Date())) {
    return sendJson(res, 200, { captured: 0, message: "Market session is closed" });
  }

  const token = process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_BEARER_TOKEN || "";
  if (!token) {
    return sendJson(res, 500, { error: "UPSTOX_ACCESS_TOKEN is missing" });
  }

  const instruments = String(process.env.RECORDER_INSTRUMENTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const targets = instruments.length ? instruments : DEFAULT_INSTRUMENTS;
  const results = await Promise.all(targets.map(async (instrumentKey) => {
    try {
      const payload = await optionChainApi.fetchLivePayload(instrumentKey, "auto", token);
      const recorder = await saveMarketSnapshot(payload);
      return { instrumentKey, expiry: payload.expiry, ok: true, recorder };
    } catch (error) {
      return { instrumentKey, ok: false, error: error.message || "Capture failed" };
    }
  }));

  return sendJson(res, results.some((item) => item.ok) ? 200 : 502, {
    captured: results.filter((item) => item.ok && item.recorder.saved).length,
    results
  });
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
