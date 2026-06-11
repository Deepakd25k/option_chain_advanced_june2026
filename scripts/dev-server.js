const http = require("http");
const fs = require("fs");
const path = require("path");
const optionChainHandler = require("../api/upstox/option-chain");
const expiriesHandler = require("../api/upstox/expiries");
const sessionHistoryHandler = require("../api/session/history");
const sessionPlaybookHandler = require("../api/session/playbook");
const cronCaptureHandler = require("../api/cron/capture");

const root = path.resolve(__dirname, "..");
loadLocalEnv(path.join(root, ".env.local"));
loadLocalEnv(path.join(root, ".env"));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/upstox/option-chain") {
    req.query = Object.fromEntries(url.searchParams.entries());
    res.status = function status(code) {
      res.statusCode = code;
      return res;
    };
    res.json = function json(payload) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };
    await optionChainHandler(req, res);
    return;
  }

  if (url.pathname === "/api/upstox/expiries") {
    req.query = Object.fromEntries(url.searchParams.entries());
    res.status = function status(code) {
      res.statusCode = code;
      return res;
    };
    res.json = function json(payload) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };
    await expiriesHandler(req, res);
    return;
  }

  if (url.pathname === "/api/session/history") {
    req.query = Object.fromEntries(url.searchParams.entries());
    attachResponseHelpers(res);
    await sessionHistoryHandler(req, res);
    return;
  }

  if (url.pathname === "/api/session/playbook") {
    req.query = Object.fromEntries(url.searchParams.entries());
    attachResponseHelpers(res);
    await sessionPlaybookHandler(req, res);
    return;
  }

  if (url.pathname === "/api/cron/capture") {
    req.query = Object.fromEntries(url.searchParams.entries());
    attachResponseHelpers(res);
    await cronCaptureHandler(req, res);
    return;
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, requestPath));

  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
    res.end(data);
  });
});

function attachResponseHelpers(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function json(payload) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  };
}

server.listen(port, host, () => {
  console.log(`Option Buyer Cockpit running at http://${host}:${port}`);
});

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
