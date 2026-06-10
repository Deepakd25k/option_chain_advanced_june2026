const UPSTOX_OPTION_CONTRACT_URL = "https://api.upstox.com/v2/option/contract";

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  const query = req.query || {};
  const instrumentKey = String(query.instrument_key || "NSE_INDEX|Nifty 50");
  const forceDemo = String(query.demo || "") === "1";
  const token = process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_BEARER_TOKEN || "";

  if (forceDemo || !token) {
    return sendJson(res, 200, {
      source: "demo",
      instrumentKey,
      expiries: demoExpiries()
    });
  }

  try {
    const url = new URL(UPSTOX_OPTION_CONTRACT_URL);
    url.searchParams.set("instrument_key", instrumentKey);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return sendJson(res, response.status, {
        source: "live",
        error: payload.message || payload.error || "Unable to fetch option expiries",
        details: payload
      });
    }

    const expiries = extractExpiries(payload.data || []);
    return sendJson(res, 200, {
      source: "live",
      instrumentKey,
      expiries
    });
  } catch (error) {
    return sendJson(res, 502, {
      source: "live",
      error: error.message || "Unable to reach Upstox"
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

function extractExpiries(contracts) {
  const today = new Date().toISOString().slice(0, 10);
  return [...new Set(contracts.map((item) => item.expiry).filter(Boolean))]
    .filter((expiry) => expiry >= today)
    .sort();
}

function demoExpiries() {
  const expiries = [];
  const date = new Date();
  while (expiries.length < 6) {
    if (date.getDay() === 2) {
      expiries.push(date.toISOString().slice(0, 10));
    }
    date.setDate(date.getDate() + 1);
  }
  return expiries;
}
