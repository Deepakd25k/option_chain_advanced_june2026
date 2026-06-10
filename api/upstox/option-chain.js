const UPSTOX_OPTION_CHAIN_URL = "https://api.upstox.com/v2/option/chain";
const UPSTOX_OPTION_CONTRACT_URL = "https://api.upstox.com/v2/option/contract";
const { saveMarketSnapshot } = require("../../lib/session-store");

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  const query = req.query || {};
  const instrumentKey = String(query.instrument_key || "NSE_INDEX|Nifty 50");
  const requestedExpiry = String(query.expiry_date || "auto");
  const forceDemo = String(query.demo || "") === "1";
  const token = process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_BEARER_TOKEN || "";

  if (forceDemo || !token) {
    const expiryDate = requestedExpiry === "auto" ? demoExpiries()[0] : requestedExpiry;
    return sendJson(res, 200, makeDemoPayload(instrumentKey, expiryDate));
  }

  try {
    const result = await fetchLivePayload(instrumentKey, requestedExpiry, token);
    result.recorder = await saveMarketSnapshot(result).catch((error) => ({
      configured: Boolean(process.env.DATABASE_URL),
      saved: false,
      reason: error.message || "Database save failed"
    }));
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 502, {
      source: "live",
      error: error.message || "Unable to reach Upstox"
    });
  }
};

async function fetchLivePayload(instrumentKey, requestedExpiry, token) {
  const expiryDate = requestedExpiry === "auto"
    ? await resolveNearestExpiry(instrumentKey, token)
    : requestedExpiry;
  const url = new URL(UPSTOX_OPTION_CHAIN_URL);
  url.searchParams.set("instrument_key", instrumentKey);
  url.searchParams.set("expiry_date", expiryDate);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Upstox option-chain request failed");
  }

  return {
    source: "live",
    generatedAt: new Date().toISOString(),
    instrumentKey,
    expiry: expiryDate,
    availableExpiries: [],
    underlying: inferUnderlying(payload.data || []),
    data: payload.data || []
  };
}

async function resolveNearestExpiry(instrumentKey, token) {
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
    throw new Error(payload.message || payload.error || "Unable to fetch option expiries");
  }
  const expiries = extractExpiries(payload.data || []);
  if (!expiries.length) {
    throw new Error("No option expiries returned by Upstox");
  }
  return expiries[0];
}

function extractExpiries(contracts) {
  const today = new Date().toISOString().slice(0, 10);
  return [...new Set(contracts.map((item) => item.expiry).filter(Boolean))]
    .filter((expiry) => expiry >= today)
    .sort();
}

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

function inferUnderlying(rows) {
  const first = Array.isArray(rows) ? rows[0] : null;
  const spot = first
    ? number(first.underlying_spot_price) || number(first.underlyingSpotPrice) || number(first.underlying_spot)
    : 0;
  return {
    spot,
    dayOpen: 0
  };
}

function makeDemoPayload(instrumentKey, expiryDate) {
  const now = Date.now();
  const base = instrumentKey.includes("SENSEX")
    ? 76500
    : instrumentKey.includes("Bank")
      ? 51200
      : instrumentKey.includes("Fin")
        ? 22400
        : 23240;
  const wave = Math.sin(now / 85000) * 45 + Math.cos(now / 37000) * 18;
  const spot = base + wave;
  const dayOpen = base - 85;
  const step = instrumentKey.includes("Bank") || instrumentKey.includes("SENSEX") ? 100 : 50;
  const atm = Math.round(spot / step) * step;
  const rows = [];

  for (let i = -10; i <= 10; i += 1) {
    const strike = atm + i * step;
    const distance = strike - spot;
    const nearness = Math.max(0.18, 1 - Math.abs(distance) / (step * 11));
    const callIntrinsic = Math.max(0, spot - strike);
    const putIntrinsic = Math.max(0, strike - spot);
    const timeValue = 18 + nearness * 58 + Math.max(0, 7 - Math.abs(i)) * 2;
    const iv = 21 + nearness * 4 + Math.sin(now / 110000 + i) * 0.7;
    const callDelta = clamp(0.52 - distance / (step * 8), 0.08, 0.92);
    const putDelta = clamp(0.52 + distance / (step * 8), 0.08, 0.92);
    const callOi = Math.round((900000 + Math.max(0, i) * 310000 + nearness * 1600000) * (1 + Math.sin(now / 90000 + i) * 0.12));
    const putOi = Math.round((900000 + Math.max(0, -i) * 340000 + nearness * 1700000) * (1 + Math.cos(now / 95000 + i) * 0.12));
    const callLtp = round(callIntrinsic + timeValue * callDelta + Math.sin(now / 29000 + i) * 2);
    const putLtp = round(putIntrinsic + timeValue * putDelta + Math.cos(now / 31000 + i) * 2);

    rows.push({
      expiry: expiryDate,
      pcr: callOi ? putOi / callOi : 0,
      strike_price: strike,
      underlying_spot_price: round(spot),
      call_options: makeOptionSide("CE", strike, callLtp, callDelta, iv, callOi, i, now),
      put_options: makeOptionSide("PE", strike, putLtp, putDelta, iv + 0.4, putOi, i, now)
    });
  }

  return {
    source: "demo",
    generatedAt: new Date().toISOString(),
    instrumentKey,
    expiry: expiryDate,
    availableExpiries: demoExpiries(),
    underlying: {
      spot: round(spot),
      dayOpen: round(dayOpen)
    },
    data: rows
  };
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

function makeOptionSide(side, strike, ltp, delta, iv, oi, offset, now) {
  const spread = Math.max(0.25, ltp * (0.004 + Math.abs(offset) * 0.0008));
  return {
    instrument_key: `DEMO|${strike}|${side}`,
    market_data: {
      ltp,
      volume: Math.round(75000 + Math.max(0, 9 - Math.abs(offset)) * 42000),
      oi,
      prev_oi: Math.round(oi * (1 + Math.sin(now / 120000 + offset) * 0.08)),
      bid_price: round(ltp - spread / 2),
      ask_price: round(ltp + spread / 2),
      bid_qty: Math.round(800 + Math.max(0, 7 - Math.abs(offset)) * 220),
      ask_qty: Math.round(850 + Math.max(0, 7 - Math.abs(offset)) * 210)
    },
    option_greeks: {
      delta: side === "CE" ? round(delta, 4) : round(-delta, 4),
      gamma: round(0.0008 + Math.max(0, 6 - Math.abs(offset)) * 0.00018, 5),
      theta: round(-(2.4 + Math.max(0, 6 - Math.abs(offset)) * 0.35), 2),
      vega: round(4 + Math.max(0, 8 - Math.abs(offset)) * 0.6, 2),
      iv: round(iv, 2),
      pop: round(48 + (side === "CE" ? delta : 1 - delta) * 20, 2)
    }
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports.fetchLivePayload = fetchLivePayload;
module.exports.resolveNearestExpiry = resolveNearestExpiry;
