const FORMULA_VERSION = "institutional-research-v2-plain-hinglish";

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

  if ((posture.key === "heavy-short" || posture.key === "net-short") && fiveImproving) {
    return {
      label: "BEARISH PRESSURE EASING",
      tone: "warn",
      meaning: cashBuying
        ? "FIIs abhi net short hain, lekin pichhle sessions me shorts kam hue aur cash buying bhi positive rahi. Bearish pressure reduce ho raha hai; abhi ise fresh bullish position mat samjho."
        : "FIIs abhi net short hain, lekin pichhle sessions me shorts kam hue. Bearish pressure reduce ho raha hai; fresh bullish position abhi confirm nahi hai."
    };
  }
  if ((posture.key === "heavy-long" || posture.key === "net-long") && fiveWorsening) {
    return {
      label: "BULLISH PRESSURE EASING",
      tone: "warn",
      meaning: cashSelling
        ? "FIIs abhi net long hain, lekin longs reduce/shorts add ho rahe hain aur cash selling bhi hai. Bullish pressure kam ho raha hai; ise turant fresh bearish regime mat samjho."
        : "FIIs abhi net long hain, lekin recent positioning weak hui hai. Bullish pressure kam ho raha hai; fresh bearish regime abhi confirm nahi hai."
    };
  }
  if (
    (posture.key === "heavy-long" || posture.key === "net-long" || posture.key === "balanced")
    && activity.key === "bullish-repositioning"
    && fiveImproving
    && cashBuying
  ) {
    return { label: "RISK-ON BUILDING", tone: "positive", meaning: "FII futures position bullish side me improve hui, multi-session trend bhi supportive hai aur cash buying confirmation mili. Live OI confirmation ke baad upside context stronger hoga." };
  }
  if (
    (posture.key === "heavy-short" || posture.key === "net-short" || posture.key === "balanced")
    && activity.key === "bearish-repositioning"
    && fiveWorsening
    && cashSelling
  ) {
    return { label: "RISK-OFF BUILDING", tone: "negative", meaning: "FII futures position bearish side me weak hui, multi-session trend bhi negative hai aur cash selling confirmation mili. Live OI confirmation ke baad downside context stronger hoga." };
  }
  if (fiveImproving || activity.tone === "positive") {
    return { label: "POSITION IMPROVING · NOT CONFIRMED", tone: "warn", meaning: "FII position improve hui hai, lekin current posture, change size ya cash flow me full agreement nahi hai. Isliye ise background upside context samjho, direct buy signal nahi." };
  }
  if (fiveWorsening || activity.tone === "negative") {
    return { label: "POSITION WEAKENING · NOT CONFIRMED", tone: "warn", meaning: "FII position weak hui hai, lekin complete bearish agreement nahi hai. Isliye ise background downside context samjho, direct sell signal nahi." };
  }
  return { label: "MIXED / HEDGED", tone: "neutral", meaning: "Futures position, aaj ka change aur cash flow ek hi direction me agree nahi kar rahe. Abhi institutional direction clear nahi hai." };
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
    meaning: !available ? "Is report date ka official NSE cash data abhi store nahi hua." : latest.cash.fiiNet > 0 ? "FIIs ne cash market me selling se zyada buying ki. Yeh supportive confirmation hai, lekin amount ka size bhi matter karta hai." : latest.cash.fiiNet < 0 ? "FIIs ne cash market me buying se zyada selling ki. Yeh market ke liye negative background flow hai." : "FII cash buying aur selling lagbhag balanced rahi."
  };
}

function explainPosition(latest, delta, posture, activity) {
  return {
    long: delta.long > 0 ? `Aaj FIIs ne ${formatContracts(Math.abs(delta.long))} long contracts add kiye. Long add hone se net position utni hi bullish improve hoti hai.` : delta.long < 0 ? `Aaj FIIs ne ${formatContracts(Math.abs(delta.long))} long contracts close kiye. Long kam hone se net position utni hi weak hoti hai.` : "Aaj FII long positions me change nahi hua.",
    short: delta.short < 0 ? `Aaj FIIs ne ${formatContracts(Math.abs(delta.short))} short contracts close kiye. Shorts kam hone se net position utni hi improve hoti hai.` : delta.short > 0 ? `Aaj FIIs ne ${formatContracts(Math.abs(delta.short))} naye short contracts add kiye. Shorts badhne se net position aur bearish hoti hai.` : "Aaj FII short positions me change nahi hua.",
    net: `Simple formula: long change ${signedContracts(delta.long)} minus short change ${signedContracts(delta.short)} = net change ${signedContracts(delta.net)}. ${delta.net > 0 ? "Positive net change ka matlab position less bearish ya more bullish hui; zaroori nahi FIIs net long ho gaye." : delta.net < 0 ? "Negative net change ka matlab position more bearish ya less bullish hui." : "Net position me koi change nahi hua."}`,
    current: latest.net < 0 ? `Abhi bhi shorts, longs se ${formatContracts(Math.abs(latest.net))} contracts zyada hain. Isliye FIIs current position me net short hi hain.` : latest.net > 0 ? `Abhi longs, shorts se ${formatContracts(latest.net)} contracts zyada hain. Isliye FIIs current position me net long hain.` : "FII index-futures longs aur shorts balanced hain.",
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

module.exports = { FORMULA_VERSION, buildInstitutionalResearch, classifyActivity, classifyRegime };
