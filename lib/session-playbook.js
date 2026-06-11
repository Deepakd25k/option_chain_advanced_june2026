const FORMULA_VERSION = "session-memory-v1";
const WALL_SCAN_STRIKES = 11;
const MAX_CONFIRMED_RANGE_POINTS = 100;

function buildSessionPlaybook(session, priorPlaybooks = []) {
  if (!session || !Array.isArray(session.snapshots) || session.snapshots.length < 2) {
    throw new Error("At least two exact completed-session snapshots are required");
  }
  const snapshots = session.snapshots.map(normalizeSnapshot).filter((item) => item.rows.length && item.spot > 0);
  if (snapshots.length < 2) throw new Error("Session snapshots do not contain usable option-chain data");

  const opening = snapshots[0];
  const closing = snapshots[snapshots.length - 1];
  const coverage = sessionCoverage(snapshots);
  if (!coverage.closingCaptured) {
    throw new Error("Exact 15:25-15:30 closing snapshot is missing; tomorrow playbook was not generated");
  }
  const step = inferStrikeStep(closing.rows);
  const openingSupport = findMaxOiWall(opening.rows, opening.spot, "PE", step);
  const openingResistance = findMaxOiWall(opening.rows, opening.spot, "CE", step);
  const closingSupport = findMaxOiWall(closing.rows, closing.spot, "PE", step);
  const closingResistance = findMaxOiWall(closing.rows, closing.spot, "CE", step);
  if (!openingSupport || !openingResistance || !closingSupport || !closingResistance) {
    throw new Error("Exact OI support/resistance could not be resolved");
  }

  const candles = (session.candles5m || []).map(normalizeCandle).filter((item) => item.close > 0 && isCompletedCashCandle(item.start));
  const confirmedRange = detectConfirmedRange(candles);
  const reference30 = exactReference(snapshots, closing.time - 30 * 60 * 1000);
  const supportFlow = exactContractChange(reference30, closing, closingSupport.strike, "PE");
  const resistanceFlow = exactContractChange(reference30, closing, closingResistance.strike, "CE");
  const finalSpotChange = reference30 ? closing.spot - reference30.spot : null;
  const spotChange = closing.spot - opening.spot;
  const supportShift = closingSupport.strike - openingSupport.strike;
  const resistanceShift = closingResistance.strike - openingResistance.strike;
  const wallDirection = alignedWallDirection(supportShift, resistanceShift);
  const closeLocation = locateSpot(closing.spot, closingSupport.strike, closingResistance.strike, step, confirmedRange);
  const spotDirection = spotChange > 0 ? "up" : spotChange < 0 ? "down" : "flat";
  const fingerprint = {
    spotDirection,
    wallDirection,
    closeLocation,
    rangeState: confirmedRange ? "confirmed-range" : "no-confirmed-range",
    expiryPhase: expiryPhase(session.sessionDate, session.expiryDate)
  };

  let story = buildSessionStory({
    opening,
    closing,
    openingSupport,
    openingResistance,
    closingSupport,
    closingResistance,
    supportFlow,
    resistanceFlow,
    finalSpotChange,
    confirmedRange,
    spotChange,
    wallDirection
  });
  if (!coverage.complete) {
    story = {
      learning: `Full-session learning withheld: opening captured ${coverage.openingCaptured ? "yes" : "no"}, exact 5m gaps ${coverage.gaps}. Closing OI levels remain actual.`,
      driver: "A complete session sequence cannot be attributed while exact opening or intermediate 5m evidence is missing.",
      failed: "This partial session is excluded from historical pattern calibration."
    };
  }
  const zones = buildTomorrowZones(closingSupport.strike, closingResistance.strike, step, confirmedRange);
  const scenarios = buildTomorrowScenarios(zones, closingSupport.strike, closingResistance.strike, closing.atmStrike);
  const exactMatches = coverage.complete
    ? priorPlaybooks.filter((item) => item.dataQuality && item.dataQuality.status === "COMPLETE" && fingerprintsEqual(item.fingerprint, fingerprint))
    : [];

  return {
    formulaVersion: FORMULA_VERSION,
    generatedAt: new Date().toISOString(),
    sessionDate: session.sessionDate,
    instrumentKey: session.instrumentKey,
    expiryDate: session.expiryDate,
    dataQuality: {
      rawSnapshots: session.snapshotCount,
      exactFiveMinuteSnapshots: snapshots.length,
      completedCandleBuckets: candles.length,
      firstSavedAt: session.firstSavedAt,
      lastSavedAt: session.lastSavedAt,
      gaps: coverage.gaps,
      status: coverage.complete ? "COMPLETE" : "PARTIAL",
      openingCaptured: coverage.openingCaptured,
      closingCaptured: coverage.closingCaptured
    },
    closing: {
      spot: closing.spot,
      atmStrike: closing.atmStrike,
      strikeStep: step,
      support: closingSupport,
      resistance: closingResistance,
      openingSupport,
      openingResistance,
      supportShift,
      resistanceShift,
      spotChange,
      confirmedRange
    },
    fingerprint,
    story,
    zones,
    scenarios,
    historicalMemory: {
      reviewedSessions: priorPlaybooks.length,
      exactMatchCount: exactMatches.length,
      exactMatchDates: exactMatches.slice(0, 5).map((item) => item.sessionDate),
      evidence: exactMatches.length < 5 ? "ANECDOTAL" : exactMatches.length < 20 ? "EARLY EVIDENCE" : "CALIBRATABLE"
    }
  };
}

function normalizeSnapshot(payload) {
  const rows = (payload.data || []).map((row) => ({
    strike: number(row.strike_price || row.strikePrice || row.strike),
    ce: normalizeSide(row.call_options || row.callOption || row.ce || row.CE),
    pe: normalizeSide(row.put_options || row.putOption || row.pe || row.PE)
  })).filter((row) => row.strike > 0).sort((a, b) => a.strike - b.strike);
  const spot = number(payload.underlying && payload.underlying.spot)
    || number((payload.data || [])[0] && (payload.data || [])[0].underlying_spot_price);
  const atm = rows.reduce((best, row) => !best || Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best, null);
  return {
    time: new Date(payload.generatedAt).getTime(),
    spot,
    atmStrike: atm ? atm.strike : 0,
    rows
  };
}

function normalizeSide(side = {}) {
  const market = side.market_data || side.marketData || side.market || side;
  const bid = number(market.bid_price || market.bidPrice || market.bid);
  const ask = number(market.ask_price || market.askPrice || market.ask);
  const ltp = number(market.ltp || market.last_price || market.lastPrice);
  return {
    oi: number(market.oi || market.open_interest || market.openInterest),
    mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : ltp
  };
}

function normalizeCandle(candle) {
  return {
    start: new Date(candle.start).getTime(),
    open: number(candle.open),
    high: number(candle.high),
    low: number(candle.low),
    close: number(candle.close)
  };
}

function inferStrikeStep(rows) {
  const counts = new Map();
  rows.slice(1).forEach((row, index) => {
    const difference = row.strike - rows[index].strike;
    if (difference > 0) counts.set(difference, (counts.get(difference) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 50;
}

function findMaxOiWall(rows, spot, side, step) {
  const support = side === "PE";
  const candidates = rows.filter((row) => support
    ? row.strike <= spot && spot - row.strike <= step * WALL_SCAN_STRIKES
    : row.strike >= spot && row.strike - spot <= step * WALL_SCAN_STRIKES
  ).map((row) => ({
    strike: row.strike,
    oi: support ? row.pe.oi : row.ce.oi
  })).filter((item) => item.oi > 0)
    .sort((a, b) => b.oi - a.oi || Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  return candidates[0] || null;
}

function detectConfirmedRange(candles) {
  for (let length = candles.length; length >= 4; length -= 1) {
    const recent = candles.slice(-length);
    const high = Math.max(...recent.map((candle) => candle.high));
    const low = Math.min(...recent.map((candle) => candle.low));
    const width = high - low;
    if (width <= 0 || width > MAX_CONFIRMED_RANGE_POINTS) continue;
    const upperBoundary = low + width * 0.8;
    const lowerBoundary = low + width * 0.2;
    const upperTouches = recent.filter((candle) => candle.high >= upperBoundary).length;
    const lowerTouches = recent.filter((candle) => candle.low <= lowerBoundary).length;
    const directionChanges = recent.slice(2).reduce((count, candle, index) => {
      const previousMove = recent[index + 1].close - recent[index].close;
      const currentMove = candle.close - recent[index + 1].close;
      return count + (previousMove && currentMove && Math.sign(previousMove) !== Math.sign(currentMove) ? 1 : 0);
    }, 0);
    if (upperTouches >= 2 && lowerTouches >= 2 && directionChanges >= 2) {
      return { low, high, width, minutes: length * 5, upperTouches, lowerTouches, directionChanges };
    }
  }
  return null;
}

function exactReference(snapshots, targetTime) {
  const nearest = snapshots.reduce((best, snapshot) => {
    const distance = Math.abs(snapshot.time - targetTime);
    return !best || distance < best.distance ? { snapshot, distance } : best;
  }, null);
  return nearest && nearest.distance <= 90 * 1000 ? nearest.snapshot : null;
}

function exactContractChange(reference, closing, strike, side) {
  if (!reference) return { available: false };
  const before = reference.rows.find((row) => row.strike === strike);
  const after = closing.rows.find((row) => row.strike === strike);
  if (!before || !after) return { available: false };
  const previous = side === "PE" ? before.pe : before.ce;
  const current = side === "PE" ? after.pe : after.ce;
  return {
    available: true,
    oiChange: current.oi - previous.oi,
    premiumChange: current.mid - previous.mid
  };
}

function alignedWallDirection(supportShift, resistanceShift) {
  if (supportShift > 0 && resistanceShift >= 0) return "up";
  if (resistanceShift < 0 && supportShift <= 0) return "down";
  if (supportShift === 0 && resistanceShift === 0) return "static";
  return "mixed";
}

function locateSpot(spot, support, resistance, step, confirmedRange) {
  if (spot < support - step / 2) return "below-support";
  if (spot <= support + step / 2) return "support-zone";
  if (spot > resistance + step / 2) return "above-resistance";
  if (spot >= resistance - step / 2) return "resistance-zone";
  if (confirmedRange && spot >= confirmedRange.low && spot <= confirmedRange.high) return "confirmed-range";
  return "between-walls";
}

function buildSessionStory(input) {
  const supportText = `${formatStrike(input.openingSupport.strike)}→${formatStrike(input.closingSupport.strike)}`;
  const resistanceText = `${formatStrike(input.openingResistance.strike)}→${formatStrike(input.closingResistance.strike)}`;
  let learning = `OI walls finished mixed: PE ${supportText}, CE ${resistanceText}; spot changed ${signed(input.spotChange)} points.`;
  if (input.wallDirection === "up" && input.spotChange > 0) {
    learning = `Both max-OI walls migrated higher with spot: PE ${supportText}, CE ${resistanceText}; spot gained ${signed(input.spotChange)} points.`;
  } else if (input.wallDirection === "down" && input.spotChange < 0) {
    learning = `Both max-OI walls migrated lower with spot: PE ${supportText}, CE ${resistanceText}; spot lost ${signed(input.spotChange)} points.`;
  } else if (input.confirmedRange) {
    learning = `A ${formatNumber(input.confirmedRange.width, 0)}-point range held for ${input.confirmedRange.minutes} minutes between ${formatStrike(input.confirmedRange.low)} and ${formatStrike(input.confirmedRange.high)}.`;
  }

  let driver = "A complete directional OI release sequence was not proven in the exact final 30m window.";
  if (input.supportFlow.available && input.resistanceFlow.available) {
    if (input.finalSpotChange > 0 && input.supportFlow.oiChange > 0 && input.resistanceFlow.oiChange < 0) {
      driver = `Final 30m gained ${signed(input.finalSpotChange)} points with support PE OI ${compact(input.supportFlow.oiChange)} / premium ${signed(input.supportFlow.premiumChange)} and resistance CE OI ${compact(input.resistanceFlow.oiChange)} / premium ${signed(input.resistanceFlow.premiumChange)}.`;
    } else if (input.finalSpotChange < 0 && input.supportFlow.oiChange < 0 && input.resistanceFlow.oiChange > 0) {
      driver = `Final 30m lost ${signed(input.finalSpotChange)} points with support PE OI ${compact(input.supportFlow.oiChange)} / premium ${signed(input.supportFlow.premiumChange)} and resistance CE OI ${compact(input.resistanceFlow.oiChange)} / premium ${signed(input.resistanceFlow.premiumChange)}.`;
    } else {
      driver = `Final 30m did not show a complete wall-release sequence: support PE OI ${compact(input.supportFlow.oiChange)} / premium ${signed(input.supportFlow.premiumChange)}, resistance CE OI ${compact(input.resistanceFlow.oiChange)} / premium ${signed(input.resistanceFlow.premiumChange)}.`;
    }
  }

  let failed = "No failed directional hypothesis can be proven from the available exact snapshots.";
  if (input.confirmedRange) {
    failed = `Directional release remained unproven while the actual ${formatNumber(input.confirmedRange.width, 0)}-point enclosure continued to satisfy the confirmed-range rule.`;
  } else if (input.finalSpotChange > 0 && input.resistanceFlow.available && input.resistanceFlow.oiChange >= 0) {
    failed = "Spot rose without resistance CE withdrawal; CE withdrawal should not be assumed as the cause of this session's rise.";
  } else if (input.finalSpotChange < 0 && input.supportFlow.available && input.supportFlow.oiChange >= 0) {
    failed = "Spot fell without support PE withdrawal; PE withdrawal should not be assumed as the cause of this session's decline.";
  }
  return { learning, driver, failed };
}

function buildTomorrowZones(support, resistance, step, confirmedRange) {
  return {
    belowSupport: { max: support - step / 2 },
    support: { low: support - step / 2, high: support + step / 2, strike: support },
    middle: confirmedRange
      ? { low: confirmedRange.low, high: confirmedRange.high, type: "confirmed-choppy-range" }
      : { low: support + step / 2, high: resistance - step / 2, type: "unclassified-between-walls" },
    resistance: { low: resistance - step / 2, high: resistance + step / 2, strike: resistance },
    aboveResistance: { min: resistance + step / 2 }
  };
}

function buildTomorrowScenarios(zones, support, resistance, atmStrike) {
  return [
    {
      key: "below-support",
      zone: `< ${formatStrike(zones.belowSupport.max)}`,
      title: "Breakdown reconciliation",
      read: "No downside assumption until the inherited support actually withdraws.",
      activation: `${formatStrike(support)} PE OI falls in two consecutive completed 5m windows, same-strike CE OI rises, and spot closes below ${formatStrike(support)}.`,
      invalidation: `Spot closes back above ${formatStrike(support)} while support PE OI stops falling.`
    },
    {
      key: "support",
      zone: `${formatStrike(zones.support.low)}–${formatStrike(zones.support.high)}`,
      title: "Inherited support test",
      read: "Upside is conditional on actual reinforcement, not the previous label alone.",
      activation: `${formatStrike(support)} PE OI rises in two consecutive completed 5m windows; ATM ${formatStrike(atmStrike)} CE OI falls while CE mid rises; spot closes above ${formatStrike(support)}.`,
      invalidation: `A completed 5m close below ${formatStrike(support)} with support PE OI falling.`
    },
    {
      key: "middle",
      zone: `${formatStrike(zones.middle.low)}–${formatStrike(zones.middle.high)}`,
      title: zones.middle.type === "confirmed-choppy-range" ? "Confirmed choppy enclosure" : "Between-wall discovery",
      read: zones.middle.type === "confirmed-choppy-range"
        ? "Choppy expectation remains valid only while both actual range boundaries hold."
        : "No choppy label is assigned because the session did not establish a confirmed range.",
      activation: zones.middle.type === "confirmed-choppy-range"
        ? `Remain range-only until a completed 5m close exits ${formatStrike(zones.middle.low)}–${formatStrike(zones.middle.high)} with the blocking OI wall withdrawing.`
        : "Wait for fresh support/resistance reinforcement or withdrawal; no directional pre-classification.",
      invalidation: zones.middle.type === "confirmed-choppy-range"
        ? `Completed 5m acceptance outside ${formatStrike(zones.middle.low)}–${formatStrike(zones.middle.high)} plus same-direction wall release.`
        : "Not applicable until fresh structure qualifies."
    },
    {
      key: "resistance",
      zone: `${formatStrike(zones.resistance.low)}–${formatStrike(zones.resistance.high)}`,
      title: "Inherited resistance test",
      read: "Downside is conditional on fresh CE reinforcement.",
      activation: `${formatStrike(resistance)} CE OI rises in two consecutive completed 5m windows; ATM ${formatStrike(atmStrike)} PE OI and PE mid both rise; spot closes below ${formatStrike(resistance)}.`,
      invalidation: `A completed 5m close above ${formatStrike(resistance)} with resistance CE OI falling.`
    },
    {
      key: "above-resistance",
      zone: `> ${formatStrike(zones.aboveResistance.min)}`,
      title: "Breakout reconciliation",
      read: "A gap/open above resistance is not accepted until inventory changes role.",
      activation: `${formatStrike(resistance)} CE OI falls and same-strike PE OI rises in two consecutive completed 5m windows, with spot closing above ${formatStrike(resistance)}.`,
      invalidation: `Spot closes back below ${formatStrike(resistance)} while resistance CE OI re-adds.`
    }
  ];
}

function fingerprintsEqual(left, right) {
  if (!left || !right) return false;
  return ["spotDirection", "wallDirection", "closeLocation", "rangeState", "expiryPhase"]
    .every((key) => left[key] === right[key]);
}

function expiryPhase(sessionDate, expiryDate) {
  const session = Date.parse(`${sessionDate}T00:00:00Z`);
  const expiry = Date.parse(`${expiryDate}T00:00:00Z`);
  const days = Math.max(0, Math.round((expiry - session) / 86400000));
  if (days === 0) return "expiry-day";
  if (days <= 2) return "near-expiry";
  return "regular";
}

function countFiveMinuteGaps(snapshots) {
  return snapshots.slice(1).filter((snapshot, index) => snapshot.time - snapshots[index].time > 7 * 60 * 1000).length;
}

function sessionCoverage(snapshots) {
  const openingMinute = istMinute(snapshots[0].time);
  const closingMinute = istMinute(snapshots[snapshots.length - 1].time);
  const gaps = countFiveMinuteGaps(snapshots);
  const openingCaptured = openingMinute >= 9 * 60 + 15 && openingMinute <= 9 * 60 + 25;
  const closingCaptured = closingMinute >= 15 * 60 + 25 && closingMinute <= 15 * 60 + 31;
  return {
    openingCaptured,
    closingCaptured,
    gaps,
    complete: openingCaptured && closingCaptured && gaps === 0
  };
}

function istMinute(time) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(time)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isCompletedCashCandle(time) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(time)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return Number(parts.hour) * 60 + Number(parts.minute) < 15 * 60 + 30;
}

function formatStrike(value) {
  return formatNumber(value, 0);
}

function formatNumber(value, decimals = 2) {
  return number(value).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function signed(value) {
  return `${number(value) > 0 ? "+" : ""}${formatNumber(value)}`;
}

function compact(value) {
  const numeric = number(value);
  const sign = numeric > 0 ? "+" : "";
  const absolute = Math.abs(numeric);
  if (absolute >= 10000000) return `${sign}${(numeric / 10000000).toFixed(2)}Cr`;
  if (absolute >= 100000) return `${sign}${(numeric / 100000).toFixed(2)}L`;
  if (absolute >= 1000) return `${sign}${(numeric / 1000).toFixed(1)}K`;
  return `${sign}${Math.round(numeric)}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  FORMULA_VERSION,
  buildSessionPlaybook,
  detectConfirmedRange,
  findMaxOiWall,
  inferStrikeStep
};
