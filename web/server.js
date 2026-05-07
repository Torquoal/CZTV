const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 8000);

const webRoot = __dirname;
const repoRoot = path.resolve(__dirname, "..");
const logDir = path.join(repoRoot, "logs");
const logFile = path.join(logDir, "usage.csv");

const CSV_FIELDS = ["server_ts", "client_ts", "sessionId", "type", "tile", "reason", "href"];

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".ico", "image/x-icon"],
]);

function utcIso() {
  return new Date().toISOString();
}

function safeJoin(base, target) {
  const targetPath = path.normalize(path.join(base, target));
  if (!targetPath.startsWith(base)) return null;
  return targetPath;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ensureLogHeader() {
  fs.mkdirSync(logDir, { recursive: true });
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, CSV_FIELDS.join(",") + "\n", "utf8");
  }
}

function appendEvents(events) {
  ensureLogHeader();
  const lines = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const row = {
      server_ts: utcIso(),
      client_ts: e.ts,
      sessionId: e.sessionId,
      type: e.type,
      tile: e.tile,
      reason: e.reason,
      href: e.href,
    };
    lines.push(CSV_FIELDS.map((k) => csvEscape(row[k])).join(","));
  }
  if (lines.length) fs.appendFileSync(logFile, lines.join("\n") + "\n", "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/log") {
    try {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const events = body.events;
      if (!Array.isArray(events)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Expected {events: []}");
        return;
      }
      appendEvents(events);
      res.writeHead(204);
      res.end();
      return;
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  const requestPath = decodeURIComponent(url.pathname);
  const rel = requestPath === "/" ? "/index.html" : requestPath;
  const abs = safeJoin(webRoot, "." + rel);
  if (!abs) {
    res.writeHead(400);
    res.end("Bad path");
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.setHeader("Content-Type", mime.get(ext) || "application/octet-stream");
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving ${webRoot}`);
  console.log(`Open http://localhost:${port}/`);
  console.log(`Logging POST /log -> ${logFile}`);
});

