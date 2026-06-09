const fs = require("fs");
const path = require("path");

const requiredFiles = [
  "index.html",
  "src/styles.css",
  "src/app.js",
  "api/upstox/option-chain.js",
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
for (const id of ["decisionTitle", "matrixTable", "strikeFinder", "chainTable"]) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`Missing DOM id: ${id}`);
    process.exit(1);
  }
}

console.log("App structure check passed.");
