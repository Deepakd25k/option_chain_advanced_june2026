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
for (const id of ["marketStructureCard", "structureHeadline", "structureTable", "structureEvidence", "matrixTable", "atmFlowTable", "outcomeTable"]) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`Missing DOM id: ${id}`);
    process.exit(1);
  }
}

const app = fs.readFileSync(path.resolve(__dirname, "..", "src/app.js"), "utf8");
const calibrationGuards = [
  "const CALIBRATION_VERSION = 3",
  "latest.source !== \"live\"",
  "isMarketSessionIst(latest.time)",
  "createStructureCalibrationSignal(structureRead, latest)",
  "buildMarketStructureRead(latest)",
  "openingBaselineSnapshots(latest)",
  "buildStructureWindow(latest, openingSnapshots",
  "supportAdding && resistanceWithdrawing",
  "resistanceAdding && supportWithdrawing",
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

console.log("App structure check passed.");
