const fs = require("fs");
const path = require("path");

const requiredFiles = [
  "index.html",
  "src/styles.css",
  "src/app.js",
  "api/upstox/option-chain.js",
  "api/session/history.js",
  "api/cron/capture.js",
  "lib/session-store.js",
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
  "outcomeTable"
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
  "setupAlreadyTracked",
  "findOutcomeSnapshot(targetTime)",
  "snapshot.source === \"live\"",
  "exitBid - signal.entryAsk",
  "checks.length < 3",
  "completed.length < 20"
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

console.log("App structure check passed.");
