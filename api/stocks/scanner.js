const { scanStockOptions } = require("../../lib/stock-options-scanner");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  const query = req.query || {};
  const token = process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_BEARER_TOKEN || "";
  const forceDemo = String(query.demo || "") === "1";

  try {
    const payload = await scanStockOptions({
      token,
      forceDemo,
      capital: query.capital,
      limit: query.limit,
      top: query.top,
      symbols: query.symbols
    });
    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, 502, {
      source: token && !forceDemo ? "live" : "demo",
      error: error.message || "Unable to scan stock options"
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
