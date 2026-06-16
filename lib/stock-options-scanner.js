const { fetchLivePayload } = require("../api/upstox/option-chain");

const UPSTOX_INSTRUMENT_SEARCH_URL = "https://api.upstox.com/v2/instruments/search";
const UPSTOX_FULL_QUOTE_URL = "https://api.upstox.com/v2/market-quote/quotes";
const NSE_ANNOUNCEMENTS_URL = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const NSE_UNDERLYINGS_URL = "https://www.nseindia.com/products-services/equity-derivatives-list-underlyings-information";
const NSE_MARKET_TIMINGS_URL = "https://www.nseindia.com/market-data/market-timings";
const NSE_SECTOR_INDEX_URL = "https://www.nseindia.com/market-data/live-equity-market";
const USER_AGENT = "Mozilla/5.0 (compatible; OptionBuyerCockpit/1.0)";

const FNO_STOCK_UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Oil & Gas", sectorIndex: "Nifty Oil & Gas", sectorKey: "NSE_INDEX|Nifty Oil & Gas" },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Bank", sectorIndex: "Nifty Bank", sectorKey: "NSE_INDEX|Nifty Bank" },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Bank", sectorIndex: "Nifty Bank", sectorKey: "NSE_INDEX|Nifty Bank" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Bank", sectorIndex: "Nifty PSU Bank", sectorKey: "NSE_INDEX|Nifty PSU Bank" },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Bank", sectorIndex: "Nifty Bank", sectorKey: "NSE_INDEX|Nifty Bank" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Bank", sectorIndex: "Nifty Bank", sectorKey: "NSE_INDEX|Nifty Bank" },
  { symbol: "INFY", name: "Infosys", sector: "IT", sectorIndex: "Nifty IT", sectorKey: "NSE_INDEX|Nifty IT" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", sectorIndex: "Nifty IT", sectorKey: "NSE_INDEX|Nifty IT" },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "IT", sectorIndex: "Nifty IT", sectorKey: "NSE_INDEX|Nifty IT" },
  { symbol: "WIPRO", name: "Wipro", sector: "IT", sectorIndex: "Nifty IT", sectorKey: "NSE_INDEX|Nifty IT" },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Auto", sectorIndex: "Nifty Auto", sectorKey: "NSE_INDEX|Nifty Auto" },
  { symbol: "M&M", name: "Mahindra & Mahindra", sector: "Auto", sectorIndex: "Nifty Auto", sectorKey: "NSE_INDEX|Nifty Auto" },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Auto", sectorIndex: "Nifty Auto", sectorKey: "NSE_INDEX|Nifty Auto" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Financial Services", sectorIndex: "Nifty Financial Services", sectorKey: "NSE_INDEX|Nifty Fin Service" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Capital Goods", sectorIndex: "Nifty India Manufacturing", sectorKey: "NSE_INDEX|Nifty India Manufacturing" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", sectorIndex: "Nifty India Digital", sectorKey: "NSE_INDEX|Nifty India Digital" },
  { symbol: "ITC", name: "ITC", sector: "FMCG", sectorIndex: "Nifty FMCG", sectorKey: "NSE_INDEX|Nifty FMCG" },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metal", sectorIndex: "Nifty Metal", sectorKey: "NSE_INDEX|Nifty Metal" },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metal", sectorIndex: "Nifty Metal", sectorKey: "NSE_INDEX|Nifty Metal" },
  { symbol: "HINDALCO", name: "Hindalco", sector: "Metal", sectorIndex: "Nifty Metal", sectorKey: "NSE_INDEX|Nifty Metal" }
];

const instrumentCache = new Map();
const announcementCache = new Map();

async function scanStockOptions(options = {}) {
  const token = options.token || "";
  const forceDemo = Boolean(options.forceDemo || !token);
  const capital = clamp(Number(options.capital) || 60000, 10000, 500000);
  const limit = clamp(Number(options.limit) || 16, 4, FNO_STOCK_UNIVERSE.length);
  const top = clamp(Number(options.top) || 4, 1, 8);
  const watchlist = parseWatchlist(options.symbols).slice(0, limit);
  const generatedAt = new Date().toISOString();
  const sectorQuotes = await loadSectorQuotes(watchlist, token, forceDemo);
  const candidates = [];
  const rejected = [];

  for (let index = 0; index < watchlist.length; index += 4) {
    const batch = watchlist.slice(index, index + 4);
    const reports = await Promise.all(batch.map((item) => scanOne(item, {
      token,
      forceDemo,
      capital,
      sectorQuote: sectorQuotes.get(item.sectorKey) || null
    })));
    for (const report of reports) {
      if (report.error) {
        rejected.push(report);
      } else {
        candidates.push(report);
      }
    }
  }

  const sorted = candidates.sort((a, b) => b.totalScore - a.totalScore);
  return {
    source: forceDemo ? "demo" : "live",
    generatedAt,
    capital,
    scanWindow: "09:20-09:25 IST opening momentum",
    universe: {
      scanned: watchlist.length,
      available: FNO_STOCK_UNIVERSE.length,
      note: "Liquid NSE F&O stock watchlist. Validate full eligibility from NSE List of Underlyings before trading."
    },
    picks: sorted.slice(0, top),
    watch: sorted.slice(top, top + 6),
    rejected: rejected.concat(sorted.slice(top + 6).map((item) => ({
      symbol: item.symbol,
      reason: "Score below top watchlist after liquidity, momentum, sector, and option filters"
    }))).slice(0, 8),
    benchmarks: [...sectorQuotes.values()],
    rules: scannerRules(),
    sources: sourceNotes()
  };
}

async function scanOne(item, context) {
  try {
    const payload = context.forceDemo
      ? makeDemoStockPayload(item)
      : await fetchLivePayload(await resolveStockInstrumentKey(item.symbol, context.token), "auto", context.token);
    const chain = normalizeChain(payload);
    if (!chain.rows.length || !chain.spot) throw new Error("Option chain missing spot/strikes");

    const sector = context.sectorQuote || demoSectorQuote(item);
    const catalyst = context.forceDemo ? demoCatalyst(item, chain) : await fetchNseAnnouncements(item.symbol).catch((error) => ({
      score: 0,
      status: "unverified",
      label: "NSE announcements not loaded",
      reason: error.message || "NSE announcements unavailable",
      sourceUrl: NSE_ANNOUNCEMENTS_URL
    }));
    const move = movementRead(chain, sector);
    const direction = chooseDirection(move);
    const contract = chooseContract(chain, direction);
    const scores = scoreCandidate(chain, contract, move, sector, catalyst, context.capital);
    const totalScore = Math.round(scores.liquidity + scores.momentum + scores.sector + scores.option + scores.catalyst - scores.riskPenalty);
    const action = classifyAction(totalScore, scores, contract, direction);

    return {
      symbol: item.symbol,
      name: item.name,
      sector: item.sector,
      sectorIndex: item.sectorIndex,
      action,
      direction,
      totalScore: clamp(totalScore, 0, 100),
      score: scores,
      spot: chain.spot,
      previousClose: chain.previousClose,
      dayOpen: chain.dayOpen,
      move,
      sectorBenchmark: sector,
      contract,
      catalyst,
      reasons: buildReasons(direction, scores, contract, move, sector, catalyst),
      invalidation: buildInvalidation(direction, chain, contract),
      sizing: buildSizing(contract, context.capital),
      source: payload.source || "live",
      expiry: payload.expiry || "auto"
    };
  } catch (error) {
    return {
      symbol: item.symbol,
      error: true,
      reason: error.message || "Unable to scan symbol"
    };
  }
}

function normalizeChain(payload) {
  const rows = (payload.data || []).map((row) => ({
    strike: number(row.strike_price || row.strikePrice),
    ce: normalizeSide(row.call_options || row.callOptions || row.CE),
    pe: normalizeSide(row.put_options || row.putOptions || row.PE)
  })).filter((row) => row.strike && (row.ce.ltp || row.pe.ltp)).sort((a, b) => a.strike - b.strike);
  const spot = number(payload.underlying && payload.underlying.spot) || number(rows[0] && rows[0].underlying_spot_price);
  return {
    spot,
    dayOpen: number(payload.underlying && payload.underlying.dayOpen) || spot,
    previousClose: number(payload.underlying && payload.underlying.previousClose),
    rows
  };
}

function normalizeSide(side) {
  const market = side && (side.market_data || side.marketData) || {};
  const greeks = side && (side.option_greeks || side.optionGreeks) || {};
  const bid = number(market.bid_price || market.bidPrice);
  const ask = number(market.ask_price || market.askPrice);
  const ltp = number(market.ltp || market.last_price || market.lastPrice);
  const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : ltp;
  return {
    instrumentKey: side && (side.instrument_key || side.instrumentKey) || "",
    ltp,
    mid,
    bid,
    ask,
    spread: bid > 0 && ask > 0 ? ask - bid : 0,
    spreadPct: mid > 0 && bid > 0 && ask > 0 ? (ask - bid) / mid : 0.08,
    volume: number(market.volume),
    oi: number(market.oi),
    prevOi: number(market.prev_oi || market.prevOi),
    bidQty: number(market.bid_qty || market.bidQty),
    askQty: number(market.ask_qty || market.askQty),
    delta: number(greeks.delta),
    gamma: number(greeks.gamma),
    theta: number(greeks.theta),
    vega: number(greeks.vega),
    iv: number(greeks.iv),
    lotSize: number(side && (side.lot_size || side.lotSize))
  };
}

function movementRead(chain, sector) {
  const previousClose = chain.previousClose || chain.dayOpen || chain.spot;
  const gapPct = previousClose ? (chain.spot - previousClose) / previousClose : 0;
  const intradayPct = chain.dayOpen ? (chain.spot - chain.dayOpen) / chain.dayOpen : 0;
  const sectorPct = number(sector.changePct);
  return {
    gapPct,
    intradayPct,
    absIntradayPct: Math.abs(intradayPct),
    sectorPct,
    relativePct: intradayPct - sectorPct,
    alignedWithSector: intradayPct === 0 || sectorPct === 0 ? false : Math.sign(intradayPct) === Math.sign(sectorPct),
    openingDrive: Math.abs(gapPct) >= 0.006 || Math.abs(intradayPct) >= 0.006
  };
}

function chooseDirection(move) {
  const primary = Math.abs(move.intradayPct) >= 0.004 ? move.intradayPct : move.gapPct;
  if (primary > 0.004) return "CE";
  if (primary < -0.004) return "PE";
  return "WAIT";
}

function chooseContract(chain, direction) {
  if (direction === "WAIT") return nullContract("No direction");
  const rows = chain.rows.map((row) => {
    const side = direction === "CE" ? row.ce : row.pe;
    return {
      strike: row.strike,
      side: direction,
      ...side,
      deltaAbs: Math.abs(side.delta),
      moneyness: direction === "CE" ? chain.spot - row.strike : row.strike - chain.spot,
      distance: Math.abs(row.strike - chain.spot)
    };
  }).filter((row) => row.mid > 0).sort((a, b) => {
    const aDelta = Math.abs(a.deltaAbs - 0.55);
    const bDelta = Math.abs(b.deltaAbs - 0.55);
    return (aDelta - bDelta) || (a.distance - b.distance);
  });
  const liquid = rows.find((row) => row.deltaAbs >= 0.38 && row.deltaAbs <= 0.72 && row.spreadPct <= 0.06) || rows[0];
  if (!liquid) return nullContract("No liquid ATM/ITM contract");
  return {
    strike: liquid.strike,
    side: direction,
    instrumentKey: liquid.instrumentKey,
    ltp: round(liquid.ltp),
    mid: round(liquid.mid),
    bid: round(liquid.bid),
    ask: round(liquid.ask),
    spreadPct: liquid.spreadPct,
    volume: liquid.volume,
    oi: liquid.oi,
    prevOi: liquid.prevOi,
    oiChange: liquid.oi - liquid.prevOi,
    delta: liquid.delta,
    gamma: liquid.gamma,
    theta: liquid.theta,
    vega: liquid.vega,
    iv: liquid.iv,
    lotSize: liquid.lotSize,
    premiumTurnover: liquid.mid * liquid.volume
  };
}

function nullContract(reason) {
  return {
    strike: 0,
    side: "WAIT",
    ltp: 0,
    mid: 0,
    bid: 0,
    ask: 0,
    spreadPct: 1,
    volume: 0,
    oi: 0,
    delta: 0,
    iv: 0,
    lotSize: 0,
    premiumTurnover: 0,
    reason
  };
}

function scoreCandidate(chain, contract, move, sector, catalyst, capital) {
  const volumeScore = scaleLog(contract.volume, 2000, 100000) * 12;
  const oiScore = scaleLog(contract.oi, 25000, 1000000) * 10;
  const turnoverScore = scaleLog(contract.premiumTurnover, 2500000, 100000000) * 8;
  const spreadScore = (1 - clamp(contract.spreadPct / 0.06, 0, 1)) * 5;
  const liquidity = volumeScore + oiScore + turnoverScore + spreadScore;

  const openingScore = clamp(move.absIntradayPct / 0.018, 0, 1) * 14;
  const gapScore = clamp(Math.abs(move.gapPct) / 0.025, 0, 1) * 6;
  const relativeScore = clamp(Math.abs(move.relativePct) / 0.014, 0, 1) * 6;
  const directionScore = move.openingDrive ? 4 : 0;
  const momentum = openingScore + gapScore + relativeScore + directionScore;

  const sectorTrend = Math.abs(sector.changePct) >= 0.003 ? 6 : 2;
  const sectorAlign = move.alignedWithSector ? 6 : 0;
  const sectorLeadership = Math.sign(move.relativePct) === Math.sign(move.intradayPct) && Math.abs(move.relativePct) >= 0.003 ? 3 : 0;
  const sectorScore = sectorTrend + sectorAlign + sectorLeadership;

  const deltaScore = (1 - clamp(Math.abs(Math.abs(contract.delta) - 0.55) / 0.3, 0, 1)) * 6;
  const ivScore = contract.iv > 0 ? (contract.iv <= 45 ? 4 : 1) : 2;
  const oiChangeScore = Math.abs(contract.oiChange || 0) > contract.oi * 0.02 ? 3 : 1;
  const option = deltaScore + ivScore + oiChangeScore + (contract.mid > 2 ? 2 : 0);

  const lotCost = contract.lotSize ? contract.ask * contract.lotSize : 0;
  const riskPenalty =
    (contract.spreadPct > 0.06 ? 12 : 0)
    + (!contract.volume ? 8 : 0)
    + (!move.openingDrive ? 6 : 0)
    + (lotCost > capital ? 12 : 0)
    + (contract.mid <= 0 ? 20 : 0);

  return {
    liquidity: round(liquidity, 1),
    momentum: round(momentum, 1),
    sector: round(sectorScore, 1),
    option: round(option, 1),
    catalyst: round(clamp(number(catalyst.score), 0, 8), 1),
    riskPenalty: round(riskPenalty, 1)
  };
}

function classifyAction(totalScore, scores, contract, direction) {
  if (direction === "WAIT") return "NO TRADE";
  if (contract.spreadPct > 0.08 || !contract.volume) return "REJECT";
  if (totalScore >= 72 && scores.riskPenalty <= 8) return "TOP PICK";
  if (totalScore >= 58) return "WATCH";
  return "LEARN ONLY";
}

function buildReasons(direction, scores, contract, move, sector, catalyst) {
  const reasons = [];
  if (direction === "WAIT") reasons.push("Opening move abhi clean CE/PE direction nahi de raha.");
  else reasons.push(`${direction} bias because stock move is ${signedPct(move.intradayPct)} from day open and ${signedPct(move.gapPct)} vs previous close.`);
  reasons.push(`Liquidity score ${scores.liquidity}/35: volume ${compact(contract.volume)}, OI ${compact(contract.oi)}, spread ${(contract.spreadPct * 100).toFixed(1)}%.`);
  reasons.push(`Sector check: ${sector.name} ${signedPct(sector.changePct)}, stock relative ${signedPct(move.relativePct)}.`);
  reasons.push(`Option math: delta ${contract.delta ? contract.delta.toFixed(2) : "--"}, IV ${contract.iv ? contract.iv.toFixed(1) : "--"}, premium turnover approx ${compact(contract.premiumTurnover)}.`);
  reasons.push(catalyst.status === "verified" ? `Catalyst: ${catalyst.label}.` : `Catalyst: ${catalyst.reason || catalyst.label}.`);
  return reasons;
}

function buildInvalidation(direction, chain, contract) {
  if (direction === "WAIT") return "Wait for opening high/low break with option spread tightening.";
  const level = direction === "CE" ? Math.min(chain.dayOpen, chain.spot * 0.996) : Math.max(chain.dayOpen, chain.spot * 1.004);
  const optionStop = contract.mid ? contract.mid * 0.75 : 0;
  return `${direction} invalid if spot loses ${round(level)} or option mid falls below ${round(optionStop)}. No averaging.`;
}

function buildSizing(contract, capital) {
  const lotCost = contract.lotSize ? contract.ask * contract.lotSize : 0;
  const maxRisk = Math.min(2000, capital * 0.03);
  const optionRisk = contract.ask ? contract.ask * 0.25 : 0;
  const riskLots = contract.lotSize && optionRisk ? Math.floor(maxRisk / (optionRisk * contract.lotSize)) : 0;
  return {
    capital,
    maxRisk,
    lotSize: contract.lotSize || null,
    lotCost: lotCost ? round(lotCost) : null,
    riskLots,
    note: lotCost && lotCost > capital ? "Capital ke bahar: strategy learning/watch only." : "Use broker margin/lot-size before any real order."
  };
}

async function loadSectorQuotes(watchlist, token, forceDemo) {
  const unique = [...new Map(watchlist.map((item) => [item.sectorKey, item])).values()];
  const rows = await Promise.all(unique.map(async (item) => {
    if (forceDemo) return demoSectorQuote(item);
    try {
      return await fetchQuote(item.sectorKey, item.sectorIndex, token);
    } catch {
      return {
        key: item.sectorKey,
        name: item.sectorIndex,
        ltp: 0,
        changePct: 0,
        source: "unavailable"
      };
    }
  }));
  return new Map(rows.map((row) => [row.key, row]));
}

async function fetchQuote(instrumentKey, name, token) {
  const url = new URL(UPSTOX_FULL_QUOTE_URL);
  url.searchParams.set("instrument_key", instrumentKey);
  const response = await fetch(url, { headers: upstoxHeaders(token) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "Quote request failed");
  const quote = Object.values(payload.data || {})[0] || {};
  const ltp = number(quote.last_price || quote.lastPrice || quote.ltp);
  const previous = number(quote.ohlc && (quote.ohlc.close || quote.ohlc.previous_close)) || number(quote.close_price);
  return {
    key: instrumentKey,
    name,
    ltp,
    changePct: previous ? (ltp - previous) / previous : number(quote.net_change) / Math.max(1, ltp - number(quote.net_change)),
    source: "Upstox market quote"
  };
}

async function resolveStockInstrumentKey(symbol, token) {
  if (instrumentCache.has(symbol)) return instrumentCache.get(symbol);
  const url = new URL(UPSTOX_INSTRUMENT_SEARCH_URL);
  url.searchParams.set("query", symbol);
  url.searchParams.set("exchanges", "NSE");
  url.searchParams.set("segments", "EQ");
  url.searchParams.set("page_number", "1");
  url.searchParams.set("records", "10");
  const response = await fetch(url, { headers: upstoxHeaders(token) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Unable to resolve ${symbol}`);
  const exact = (Array.isArray(payload.data) ? payload.data : []).find((item) => {
    const trading = String(item.trading_symbol || item.tradingsymbol || item.symbol || "").toUpperCase();
    return trading === symbol.toUpperCase() && item.instrument_key;
  });
  if (!exact) throw new Error(`No NSE_EQ instrument found for ${symbol}`);
  instrumentCache.set(symbol, exact.instrument_key);
  return exact.instrument_key;
}

async function fetchNseAnnouncements(symbol) {
  const cacheKey = `${symbol}:${istDate()}`;
  if (announcementCache.has(cacheKey)) return announcementCache.get(cacheKey);
  const api = new URL("https://www.nseindia.com/api/corporate-announcements");
  api.searchParams.set("index", "equities");
  api.searchParams.set("symbol", symbol);
  const response = await fetch(api, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json,text/plain,*/*",
      Referer: NSE_ANNOUNCEMENTS_URL
    }
  });
  if (!response.ok) throw new Error(`NSE announcements request failed with ${response.status}`);
  const rows = await response.json();
  const today = istDate();
  const hit = (Array.isArray(rows) ? rows : []).find((row) => {
    const text = `${row.an_dt || row.attchmntText || row.desc || row.sm_name || ""}`;
    return text.includes(today.slice(8)) || String(row.symbol || "").toUpperCase() === symbol.toUpperCase();
  });
  const value = hit ? {
    score: 6,
    status: "verified",
    label: String(hit.attchmntText || hit.desc || "NSE corporate announcement").slice(0, 110),
    reason: "Fresh NSE corporate filing found",
    sourceUrl: NSE_ANNOUNCEMENTS_URL
  } : {
    score: 0,
    status: "verified",
    label: "No fresh NSE corporate announcement in latest fetch",
    reason: "No fresh NSE filing detected",
    sourceUrl: NSE_ANNOUNCEMENTS_URL
  };
  announcementCache.set(cacheKey, value);
  return value;
}

function makeDemoStockPayload(item) {
  const now = Date.now();
  const seed = item.symbol.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  const base = 600 + (seed % 26) * 85;
  const direction = seed % 3 === 0 ? -1 : 1;
  const drive = direction * (base * (0.004 + (seed % 8) / 1000) + Math.sin(now / 90000 + seed) * base * 0.002);
  const spot = base + drive;
  const previousClose = base * (1 - direction * 0.006);
  const dayOpen = base * (1 - direction * 0.004);
  const step = base > 1800 ? 20 : base > 900 ? 10 : 5;
  const atm = Math.round(spot / step) * step;
  const rows = [];
  for (let offset = -8; offset <= 8; offset += 1) {
    const strike = atm + offset * step;
    const distance = strike - spot;
    const nearness = Math.max(0.2, 1 - Math.abs(offset) / 9);
    const callDelta = clamp(0.52 - distance / (step * 7), 0.08, 0.92);
    const putDelta = clamp(0.52 + distance / (step * 7), 0.08, 0.92);
    const timeValue = 8 + nearness * 32 + (seed % 5);
    const callLtp = Math.max(1, Math.max(0, spot - strike) + timeValue * callDelta);
    const putLtp = Math.max(1, Math.max(0, strike - spot) + timeValue * putDelta);
    rows.push({
      strike_price: strike,
      underlying_spot_price: spot,
      call_options: makeDemoOption("CE", strike, callLtp, callDelta, seed, offset, now),
      put_options: makeDemoOption("PE", strike, putLtp, -putDelta, seed, offset, now)
    });
  }
  return {
    source: "demo",
    generatedAt: new Date(now).toISOString(),
    instrumentKey: `DEMO_EQ|${item.symbol}`,
    expiry: nextTuesday(),
    underlying: { spot: round(spot), dayOpen: round(dayOpen), previousClose: round(previousClose) },
    data: rows
  };
}

function makeDemoOption(side, strike, ltp, delta, seed, offset, now) {
  const spread = Math.max(0.1, ltp * (0.012 + Math.abs(offset) * 0.002));
  const oi = Math.round(75000 + Math.max(0, 8 - Math.abs(offset)) * 85000 + (seed % 9) * 12000);
  return {
    instrument_key: `DEMO|${strike}|${side}`,
    market_data: {
      ltp: round(ltp),
      volume: Math.round(4000 + Math.max(0, 8 - Math.abs(offset)) * 9000 + (seed % 7) * 1700),
      oi,
      prev_oi: Math.round(oi * (0.97 + Math.sin(now / 120000 + seed + offset) * 0.03)),
      bid_price: round(ltp - spread / 2),
      ask_price: round(ltp + spread / 2),
      bid_qty: 500 + Math.max(0, 7 - Math.abs(offset)) * 150,
      ask_qty: 520 + Math.max(0, 7 - Math.abs(offset)) * 140
    },
    option_greeks: {
      delta: round(delta, 4),
      gamma: round(0.001 + Math.max(0, 6 - Math.abs(offset)) * 0.0002, 5),
      theta: round(-(1.6 + Math.max(0, 6 - Math.abs(offset)) * 0.28), 2),
      vega: round(2 + Math.max(0, 7 - Math.abs(offset)) * 0.5, 2),
      iv: round(24 + (seed % 8) + Math.max(0, 5 - Math.abs(offset)) * 0.8, 2)
    },
    lot_size: 500
  };
}

function demoSectorQuote(item) {
  const seed = item.sectorIndex.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  return {
    key: item.sectorKey,
    name: item.sectorIndex,
    ltp: 10000 + seed * 3,
    changePct: ((seed % 9) - 3) / 1000,
    source: "demo sector benchmark"
  };
}

function demoCatalyst(item, chain) {
  const strong = Math.abs((chain.spot - chain.previousClose) / chain.previousClose) > 0.012;
  return {
    score: strong ? 4 : 0,
    status: "demo",
    label: strong ? `${item.symbol} opening drive demo catalyst` : "No demo catalyst",
    reason: strong ? "Demo mode: strong opening move treated as catalyst proxy" : "No verified news in demo mode",
    sourceUrl: NSE_ANNOUNCEMENTS_URL
  };
}

function parseWatchlist(value) {
  if (!value) return FNO_STOCK_UNIVERSE;
  const wanted = new Set(String(value).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean));
  const filtered = FNO_STOCK_UNIVERSE.filter((item) => wanted.has(item.symbol));
  return filtered.length ? filtered : FNO_STOCK_UNIVERSE;
}

function scannerRules() {
  return [
    "Universe: NSE F&O stock underlyings only; this app starts with a liquid watchlist to avoid rate-limit heavy full-universe polling.",
    "Timing: 09:15-09:20 no-trade observation, 09:20-09:25 scan, then only opening high/low/VWAP-style confirmation outside this MVP.",
    "Liquidity first: tight bid-ask spread, meaningful option volume/OI, and premium turnover proxy.",
    "Direction: stock gap/intraday drive must agree with option delta and preferably sector benchmark.",
    "Risk: one trade at a time for small capital; reject contracts whose lot cost is outside capital or spread is too wide."
  ];
}

function sourceNotes() {
  return [
    { label: "NSE equity-derivatives market timings", url: NSE_MARKET_TIMINGS_URL },
    { label: "NSE F&O underlyings reference", url: NSE_UNDERLYINGS_URL },
    { label: "NSE corporate announcements", url: NSE_ANNOUNCEMENTS_URL },
    { label: "NSE sector/live equity market reference", url: NSE_SECTOR_INDEX_URL },
    { label: "Upstox option-chain and quote data", url: "https://upstox.com/developer/api-documentation/" }
  ];
}

function upstoxHeaders(token) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

function scaleLog(value, min, max) {
  if (value <= min) return 0;
  return clamp((Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min)), 0, 1);
}

function istDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextTuesday() {
  const date = new Date();
  while (date.getDay() !== 2) date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, number(value)));
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(number(value) * factor) / factor;
}

function compact(value) {
  const numeric = number(value);
  const abs = Math.abs(numeric);
  const sign = numeric < 0 ? "-" : "";
  if (abs >= 10000000) return `${sign}${(abs / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function signedPct(value) {
  const numeric = number(value) * 100;
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

module.exports = {
  FNO_STOCK_UNIVERSE,
  scanStockOptions,
  scannerRules,
  sourceNotes
};
