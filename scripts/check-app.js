const fs = require("fs");
const path = require("path");

const requiredFiles = [
  "index.html",
  "src/styles.css",
  "src/app.js",
  "api/upstox/option-chain.js",
  "api/session/history.js",
  "api/session/playbook.js",
  "api/cron/capture.js",
  "lib/session-store.js",
  "lib/session-playbook.js",
  "db/schema.sql",
  "scripts/dev-server.js",
  "vercel.json",
  "package.json"
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.resolve(__dirname, "..", file)));

if (missing.length) {
  console.error(`Missing files: ${missing.join(", ")}`);
  process.exit(1);
}

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
for (const id of [
  "marketStructureCard",
  "structureHeadline",
  "pressureHeadline",
  "pressureVerdict",
  "pressureMetrics",
  "pressureNarrative",
  "structureTable",
  "structureEvidence",
  "matrixTable",
  "outcomeTable",
  "sessionMemoryCard",
  "memoryHeadline",
  "memoryScenarios",
  "eventCenterButton",
  "eventUnreadCount",
  "eventToastStack",
  "eventDrawer",
  "eventTape"
]) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`Missing DOM id: ${id}`);
    process.exit(1);
  }
}

if (html.includes("ATM Flow Matrix") || html.includes('id="atmFlowTable"')) {
  console.error("ATM Flow Matrix should be fully removed");
  process.exit(1);
}

const app = fs.readFileSync(path.resolve(__dirname, "..", "src/app.js"), "utf8");
if (app.includes("renderAtmFlowWatch") || app.includes("atmFlowRange")) {
  console.error("Legacy ATM Flow Matrix code should be fully removed");
  process.exit(1);
}
const calibrationGuards = [
  "const CALIBRATION_VERSION = 3",
  "latest.source !== \"live\"",
  "isMarketSessionIst(latest.time)",
  "createStructureCalibrationSignal(structureRead, latest)",
  "buildMarketStructureRead(latest)",
  "openingBaselineSnapshots(latest)",
  "buildStructureWindow(latest, openingSnapshots",
  "const WALL_SCAN_STRIKES = 11",
  "const MAX_CONFIRMED_RANGE_POINTS = 100",
  "classifyStructureInventory(windows, definition.side)",
  "directionChanges >= 2",
  "max PE/CE OI walls inside ATM",
  "findMaxOiWall(latest.rows, latest.spot, side, step)",
  "state.sessionHydrated",
  "supportAdding && resistanceWithdrawing",
  "resistanceAdding && supportWithdrawing",
  "buildPressureResponseRead(latest",
  "sessionMedianFiveMinuteMove(latest.time)",
  "detectInventoryRoleFlip(latest",
  "pressurePathLoad(latest",
  "PRESSURE ABSORBED",
  "NO CAUSAL EDGE",
  "DB ready · market closed",
  "DB ready · no data today",
  "Database history request timed out",
  "loadSessionPlaybook()",
  "/api/session/playbook?",
  "exact pattern match",
  "setupAlreadyTracked",
  "findOutcomeSnapshot(targetTime)",
  "snapshot.source === \"live\"",
  "exitBid - signal.entryAsk",
  "checks.length < 3",
  "completed.length < 20",
  "EVENT_TOAST_MS = 60 * 1000",
  "updateStructureEventTape(structureRead, latest)",
  "millisecondsIntoBucket > 2 * 60 * 1000",
  "processEventObservation",
  "flushEventNotifications",
  "+${relatedCount} related",
  "event.windows >= 3",
  "UPSIDE",
  "ABSORBED",
  "wallInventoryMeaning",
  "UNVERIFIED GAP"
];

for (const guard of calibrationGuards) {
  if (!app.includes(guard)) {
    console.error(`Missing calibration v2 guard: ${guard}`);
    process.exit(1);
  }
}

const sessionStore = fs.readFileSync(path.resolve(__dirname, "..", "lib/session-store.js"), "utf8");
for (const guard of [
  "date_bin(",
  "loadSessionCandles(sql",
  "GROUP BY 1",
  "Session candle reconstruction failed",
  "candles5m: candleRows.map",
  "array_agg(spot ORDER BY captured_at ASC)"
]) {
  if (!sessionStore.includes(guard)) {
    console.error(`Missing session range-history guard: ${guard}`);
    process.exit(1);
  }
}

const sessionPlaybook = fs.readFileSync(path.resolve(__dirname, "..", "lib/session-playbook.js"), "utf8");
for (const guard of [
  "session-memory-v2-gap-aware",
  "WALL_SCAN_STRIKES = 11",
  "MAX_CONFIRMED_RANGE_POINTS = 100",
  "findMaxOiWall",
  "snapshots[snapshots.length - 1]",
  "exactFiveMinuteSnapshots",
  "two consecutive completed 5m windows",
  "fingerprintsEqual"
]) {
  if (!sessionPlaybook.includes(guard)) {
    console.error(`Missing session playbook guard: ${guard}`);
    process.exit(1);
  }
}

for (const guard of [
  "missingBuckets",
  "observedCoveragePct",
  "continuousClosingReference",
  "latestContiguousCandles",
  "range-unobserved-across-gaps",
  "isMemoryEligible",
  'status: !memoryEligible ? "PARTIAL" : missingBuckets ? "GAP-AWARE" : "COMPLETE"'
]) {
  if (!sessionPlaybook.includes(guard)) {
    console.error(`Missing gap-aware playbook guard: ${guard}`);
    process.exit(1);
  }
}

const {
  buildSessionPlaybook,
  detectConfirmedRange,
  findMaxOiWall,
  inferStrikeStep
} = require(path.resolve(__dirname, "..", "lib/session-playbook.js"));
const regressionRows = [
  { strike: 23000, ce: { oi: 1980000 }, pe: { oi: 8517000 } },
  { strike: 23050, ce: { oi: 761000 }, pe: { oi: 2710000 } },
  { strike: 23100, ce: { oi: 3791000 }, pe: { oi: 8634000 } },
  { strike: 23150, ce: { oi: 2596000 }, pe: { oi: 4398000 } },
  { strike: 23200, ce: { oi: 6871000 }, pe: { oi: 6864000 } },
  { strike: 23250, ce: { oi: 3102000 }, pe: { oi: 1707000 } },
  { strike: 23300, ce: { oi: 7341000 }, pe: { oi: 3963000 } },
  { strike: 23350, ce: { oi: 3284000 }, pe: { oi: 0 } },
  { strike: 23400, ce: { oi: 6433000 }, pe: { oi: 2295000 } },
  { strike: 23450, ce: { oi: 2320000 }, pe: { oi: 376000 } },
  { strike: 23500, ce: { oi: 7385000 }, pe: { oi: 1976000 } }
];
const regressionStep = inferStrikeStep(regressionRows);
const regressionSupport = findMaxOiWall(regressionRows, 23202.9, "PE", regressionStep);
const regressionResistance = findMaxOiWall(regressionRows, 23202.9, "CE", regressionStep);
if (regressionStep !== 50 || regressionSupport.strike !== 23100 || regressionResistance.strike !== 23500) {
  console.error("Session playbook wall regression failed");
  process.exit(1);
}

const exactRange = detectConfirmedRange([
  { start: 1, open: 110, high: 160, low: 100, close: 150 },
  { start: 2, open: 150, high: 165, low: 120, close: 125 },
  { start: 3, open: 125, high: 140, low: 100, close: 135 },
  { start: 4, open: 135, high: 165, low: 110, close: 120 }
]);
if (!exactRange || exactRange.width !== 65) {
  console.error("Session playbook must preserve the actual confirmed range width");
  process.exit(1);
}

function regressionPayload(time, spot) {
  return {
    source: "live",
    generatedAt: time,
    underlying: { spot },
    data: regressionRows.map((row) => ({
      strike_price: row.strike,
      underlying_spot_price: spot,
      call_options: { market_data: { oi: row.ce.oi, ltp: 100, bid_price: 99, ask_price: 101 } },
      put_options: { market_data: { oi: row.pe.oi, ltp: 100, bid_price: 99, ask_price: 101 } }
    }))
  };
}

const regressionPlaybook = buildSessionPlaybook({
  sessionDate: "2026-06-11",
  expiryDate: "2026-06-16",
  instrumentKey: "NSE_INDEX|Nifty 50",
  snapshotCount: 2,
  firstSavedAt: "2026-06-11T03:50:00.000Z",
  lastSavedAt: "2026-06-11T10:00:00.000Z",
  snapshots: [
    regressionPayload("2026-06-11T03:50:00.000Z", 23202.9),
    regressionPayload("2026-06-11T10:00:00.000Z", 23202.9)
  ],
  candles5m: [
    { start: "2026-06-11T04:00:00.000Z", open: 23110, high: 23160, low: 23100, close: 23150 },
    { start: "2026-06-11T04:05:00.000Z", open: 23150, high: 23165, low: 23120, close: 23125 },
    { start: "2026-06-11T04:10:00.000Z", open: 23125, high: 23140, low: 23100, close: 23135 },
    { start: "2026-06-11T04:15:00.000Z", open: 23135, high: 23165, low: 23110, close: 23120 }
  ]
});
if (
  regressionPlaybook.closing.support.strike !== 23100
  || regressionPlaybook.closing.resistance.strike !== 23500
  || regressionPlaybook.closing.confirmedRange.width !== 65
  || regressionPlaybook.scenarios.length !== 5
) {
  console.error("Session playbook end-to-end regression failed");
  process.exit(1);
}


const gapAwarePlaybook = buildSessionPlaybook({
  sessionDate: "2026-06-11",
  expiryDate: "2026-06-16",
  instrumentKey: "NSE_INDEX|Nifty 50",
  snapshotCount: 4,
  firstSavedAt: "2026-06-11T03:50:00.000Z",
  lastSavedAt: "2026-06-11T10:00:00.000Z",
  snapshots: [
    regressionPayload("2026-06-11T03:50:00.000Z", 23202.9),
    regressionPayload("2026-06-11T03:55:00.000Z", 23210),
    regressionPayload("2026-06-11T04:15:00.000Z", 23220),
    regressionPayload("2026-06-11T10:00:00.000Z", 23202.9)
  ],
  candles5m: [
    { start: "2026-06-11T03:50:00.000Z", open: 23202, high: 23210, low: 23200, close: 23208 },
    { start: "2026-06-11T03:55:00.000Z", open: 23208, high: 23214, low: 23205, close: 23210 },
    { start: "2026-06-11T04:15:00.000Z", open: 23220, high: 23225, low: 23215, close: 23222 },
    { start: "2026-06-11T10:00:00.000Z", open: 23205, high: 23210, low: 23200, close: 23202 }
  ]
});
if (
  gapAwarePlaybook.dataQuality.status !== "GAP-AWARE"
  || gapAwarePlaybook.dataQuality.missingBuckets < 1
  || !gapAwarePlaybook.dataQuality.memoryEligible
  || !gapAwarePlaybook.story.learning.includes("were ignored, not estimated")
) {
  console.error("Gap-aware session playbook regression failed");
  process.exit(1);
}

console.log("App structure check passed.");
