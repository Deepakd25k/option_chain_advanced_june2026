const FORMULA_VERSION = "institutional-research-v1";

function buildInstitutionalResearch(records) {
  const history = (records || []).map(normalizeRecord).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  if (!history.length) return { ready: false, reason: "No verified NSE participant history is available" };
  const latest = history[history.length - 1];
  const previous = history[history.length - 2] || null;
  const today = previous ? changes(latest, previous) : emptyChanges();
  const five = aggregateChanges(history.slice(-6));
  const twenty = history.slice(-21);
  const materiality = buildMateriality(today, twenty);
  const activity = classifyActivity(today, materiality);
  const posture = classifyPosture(latest);
  const cash = cashRead(latest, history);
  const regime = classifyRegime(posture, activity, five, cash);

  return {
    ready: true,
    formulaVersion: FORMULA_VERSION,
    reportDate: latest.date,
    verified: latest.verified,
    source: latest.source,
    latest,
    previousDate: previous && previous.date,
    posture,
    activity,
    regime,
    today,
    five,
    twentySessionCount: twenty.length,
    materiality,
    cash,
    explanation: explainPosition(latest, today, posture, activity),
    scenarios: scenarioMeanings(),
    dataQuality: {
      verifiedSessions: history.length,
      participantHistoryReady: history.length >= 5,
      materialityReady: twenty.length >= 10,
      cashHistorySessions: history.filter((item) => item.cash && item.cash.date === item.date).length
    }
  };
}

function normalizeRecord(record) {
  if (!record || !record.tradeDate || !record.fii) return null;
  const fii = record.fii;
  const long = number(fii.futureIndexLong);
  const short = number(fii.futureIndexShort);
  if (long < 0 || short < 0) return null;
  return {
    date: String(record.tradeDate),
    verified: Boolean(record.verified),
    source: record.source || {},
    long,
    short,
    net: long - short,
    gross: long + short,
    longRatio: long + short ? long / (long + short) : 0,
    futureStockLong: number(fii.futureStockLong),
    futureStockShort: number(fii.futureStockShort),
    callLong: number(fii.optionIndexCallLong),
    callShort: number(fii.optionIndexCallShort),
    putLong: number(fii.optionIndexPutLong),
    putShort: number(fii.optionIndexPutShort),
    cash: record.cash && record.cash.date ? {
      date: String(record.cash.date),
      fiiNet: nullableNumber(record.cash.fiiNet),
      diiNet: nullableNumber(record.cash.diiNet),
      sourceUrl: record.cash.sourceUrl || ""
    } : null
  };
}

function changes(latest, previous) {
  return {
    long: latest.long - previous.long,
    short: latest.short - previous.short,
    net: latest.net - previous.net,
    gross: latest.gross - previous.gross,
    longRatioPoints: (latest.longRatio - previous.longRatio) * 100,
    longPct: percentChange(latest.long, previous.long),
    shortPct: percentChange(latest.short, previous.short),
    netPctOfGross: previous.gross ? ((latest.net - previous.net) / previous.gross) * 100 : 0,
    callLong: latest.callLong - previous.callLong,
    callShort: latest.callShort - previous.callShort,
    putLong: latest.putLong - previous.putLong,
    putShort: latest.putShort - previous.putShort
  };
}

function emptyChanges() {
  return { long: 0, short: 0, net: 0, gross: 0, longRatioPoints: 0, longPct: 0, shortPct: 0, netPctOfGross: 0 };
}

function aggregateChanges(records) {
  if (records.length < 2) return { available: false, sessions: records.length };
  const first = records[0];
  const last = records[records.length - 1];
  const delta = changes(last, first);
  const daily = records.slice(1).map((record, index) => changes(record, records[index]));
  return {
    available: true,
    sessions: records.length - 1,
    ...delta,
    longAddedSessions: daily.filter((item) => item.long > 0).length,
    shortReducedSessions: daily.filter((item) => item.short < 0).length,
    shortAddedSessions: daily.filter((item) => item.short > 0).length,
    netImprovedSessions: daily.filter((item) => item.net > 0).length
  };
}

function classifyPosture(latest) {
  if (!latest.gross) return { key: "neutral", label: "NO POSITION", tone: "neutral" };
  const shortShare = latest.short / latest.gross;
  if (shortShare >= 0.7) return { key: "heavy-short", label: "HEAVILY NET SHORT", tone: "negative" };
  if (shortShare > 0.55) return { key: "net-short", label: "NET SHORT", tone: "negative" };
  if (shortShare <= 0.3) return { key: "heavy-long", label: "HEAVILY NET LONG", tone: "positive" };
  if (shortShare < 0.45) return { key: "net-long", label: "NET LONG", tone: "positive" };
  return { key: "balanced", label: "BALANCED POSITION", tone: "neutral" };
}

function classifyActivity(delta, materiality = null) {
  if (materiality && materiality.ready && materiality.net.rank !== null && materiality.net.rank <= 20) {
    return { key: "little-change", label: "SMALL POSITION CHANGE", tone: "neutral", meaning: "The long-short combination changed, but its net effect ranks in the smallest 20% of the available 20-session history. It is context, not a fresh directional regime." };
  }
  if (delta.long > 0 && delta.short < 0) {
    return { key: "bullish-repositioning", label: "BULLISH REPOSITIONING", tone: "positive", meaning: "New bullish contracts were added and bearish contracts were closed. Both changes improved the net position." };
  }
  if (delta.long < 0 && delta.short > 0) {
    return { key: "bearish-repositioning", label: "BEARISH REPOSITIONING", tone: "negative", meaning: "Bullish contracts were closed and new bearish contracts were added. Both changes made the net position more bearish." };
  }
  if (delta.long > 0 && delta.short > 0) {
    return { key: "two-sided-expansion", label: "TWO-SIDED EXPANSION", tone: delta.net > 0 ? "positive" : delta.net < 0 ? "negative" : "neutral", meaning: "FIIs increased both bullish and bearish futures exposure. The net change shows which side grew faster; hedging may also be involved." };
  }
  if (delta.long < 0 && delta.short < 0) {
    const coveringLed = Math.abs(delta.short) > Math.abs(delta.long);
    return { key: "exposure-reduction", label: coveringLed ? "SHORT-COVERING LED EXIT" : "EXPOSURE REDUCTION", tone: delta.net > 0 ? "positive" : delta.net < 0 ? "negative" : "neutral", meaning: coveringLed ? "Both sides reduced exposure, but more bearish contracts were closed than bullish contracts. The position became less bearish." : "FIIs reduced both bullish and bearish contracts. Directional conviction is weaker than a clean buildup." };
  }
  return { key: "little-change", label: "NO MEANINGFUL POSITION CHANGE", tone: "neutral", meaning: "Long and short positions changed only marginally or history is still building." };
}

function classifyRegime(posture, activity, five, cash) {
  const fiveImproving = five.available && five.net > 0 && five.short < 0;
  const fiveWorsening = five.available && five.net < 0 && five.short > 0;
  const cashBuying = cash.available && cash.today > 0;
  const cashSelling = cash.available && cash.today < 0;
  if ((activity.key === "bullish-repositioning" || fiveImproving) && cashBuying) {
    return { label: "RISK-ON BUILDING", tone: "positive", meaning: "Futures positioning improved and cash buying confirmed institutional demand." };
  }
  if ((activity.key === "bearish-repositioning" || fiveWorsening) && cashSelling) {
    return { label: "RISK-OFF BUILDING", tone: "negative", meaning: "Futures positioning weakened and cash selling confirmed defensive institutional behaviour." };
  }
  if (fiveImproving || (activity.tone === "positive" && posture.tone === "negative")) {
    return { label: "BEARISH PRESSURE EASING", tone: "warn", meaning: cashSelling ? "Short pressure is reducing, but cash selling means genuine risk-on is not confirmed." : "Short pressure is reducing. Live OI must confirm whether this becomes a sustainable rally." };
  }
  if (fiveWorsening || (activity.tone === "negative" && posture.tone === "positive")) {
    return { label: "BULLISH PRESSURE EASING", tone: "warn", meaning: "Institutional positioning is deteriorating, but the existing position has not fully changed regime." };
  }
  return { label: "MIXED / HEDGED", tone: "neutral", meaning: "Position, activity and cash flow do not provide one clean institutional direction." };
}

function buildMateriality(today, history) {
  if (history.length < 3) return { ready: false, long: unavailableRank(), short: unavailableRank(), net: unavailableRank() };
  const daily = history.slice(1).map((record, index) => changes(record, history[index]));
  return {
    ready: history.length >= 10,
    long: rankChange(Math.abs(today.long), daily.map((item) => Math.abs(item.long))),
    short: rankChange(Math.abs(today.short), daily.map((item) => Math.abs(item.short))),
    net: rankChange(Math.abs(today.net), daily.map((item) => Math.abs(item.net)))
  };
}

function rankChange(value, observations) {
  if (!observations.length) return unavailableRank();
  const rank = Math.round((observations.filter((item) => item <= value).length / observations.length) * 100);
  return { rank, label: rank >= 80 ? "Unusually large" : rank <= 20 ? "Small" : "Normal" };
}

function unavailableRank() {
  return { rank: null, label: "History building" };
}

function cashRead(latest, history) {
  const available = Boolean(latest.cash && latest.cash.date === latest.date && latest.cash.fiiNet !== null);
  const recent = history.filter((item) => item.cash && item.cash.date === item.date && item.cash.fiiNet !== null).slice(-5);
  return {
    available,
    today: available ? latest.cash.fiiNet : null,
    diiToday: available ? latest.cash.diiNet : null,
    collectedSessions: history.filter((item) => item.cash && item.cash.date === item.date).length,
    fiveSessionTotal: recent.length ? recent.reduce((total, item) => total + item.cash.fiiNet, 0) : null,
    fiveSessionCount: recent.length,
    meaning: !available ? "Official NSE cash data for this report date has not been stored yet." : latest.cash.fiiNet > 0 ? "FIIs bought more cash equities than they sold." : latest.cash.fiiNet < 0 ? "FIIs sold more cash equities than they bought." : "FII cash buying and selling were balanced."
  };
}

function explainPosition(latest, delta, posture, activity) {
  return {
    long: delta.long > 0 ? `FIIs added ${formatContracts(Math.abs(delta.long))} bullish futures contracts. This improved their net position by the same amount.` : delta.long < 0 ? `FIIs closed ${formatContracts(Math.abs(delta.long))} bullish futures contracts. This weakened their net position by the same amount.` : "FII bullish futures positions were unchanged.",
    short: delta.short < 0 ? `FIIs closed ${formatContracts(Math.abs(delta.short))} bearish futures contracts. Fewer shorts improved the net position by the same amount.` : delta.short > 0 ? `FIIs added ${formatContracts(Math.abs(delta.short))} bearish futures contracts. More shorts made the net position more bearish.` : "FII bearish futures positions were unchanged.",
    net: `Long change ${signedContracts(delta.long)} minus short change ${signedContracts(delta.short)} equals net change ${signedContracts(delta.net)}. ${delta.net > 0 ? "The position became less bearish or more bullish." : delta.net < 0 ? "The position became more bearish or less bullish." : "The net position did not change."}`,
    current: latest.net < 0 ? `Shorts still exceed longs by ${formatContracts(Math.abs(latest.net))}. FIIs remain net short despite today's improvement.` : latest.net > 0 ? `Longs exceed shorts by ${formatContracts(latest.net)}. FIIs are currently net long.` : "FII index-futures longs and shorts are balanced.",
    combined: `${activity.meaning} Current posture: ${posture.label.toLowerCase()}.`
  };
}

function scenarioMeanings() {
  return [
    { title: "Longs added + shorts closed", meaning: "Both changes improve the net position. This is the cleanest bullish repositioning combination." },
    { title: "Longs closed + shorts added", meaning: "Both changes weaken the net position. This is the cleanest bearish repositioning combination." },
    { title: "Longs and shorts both added", meaning: "Gross exposure expanded. The larger side controls net direction, but hedging may be present." },
    { title: "Longs and shorts both closed", meaning: "Gross exposure fell. This is position reduction, not automatically a fresh directional view." }
  ];
}

function formatContracts(value) {
  return Math.round(number(value)).toLocaleString("en-IN");
}

function signedContracts(value) {
  const numeric = number(value);
  return `${numeric > 0 ? "+" : numeric < 0 ? "-" : ""}${formatContracts(Math.abs(numeric))}`;
}

function percentChange(current, previous) {
  return previous ? ((current - previous) / Math.abs(previous)) * 100 : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = { FORMULA_VERSION, buildInstitutionalResearch, classifyActivity };
