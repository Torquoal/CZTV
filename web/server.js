const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 8000);

const webRoot = __dirname;
const repoRoot = path.resolve(__dirname, "..");
const mediaRoot = path.join(repoRoot, "media");
const webMediaRoot = path.join(webRoot, "media");
const logDir = path.join(repoRoot, "logs");
const logFile = path.join(logDir, "usage.csv");

const CSV_FIELDS = [
  "server_ts",
  "client_ts",
  "sessionId",
  "participantID",
  "mode",
  "preset",
  "type",
  "tile",
  "reason",
  "href",
  "meta",
];

const EXPECTED_CSV_HEADER = CSV_FIELDS.join(",");
const EXPECTED_CSV_HEADER_NORM = CSV_FIELDS.map((s) => s.trim()).join(",");

function normalizeCsvHeaderLine(line) {
  return (line || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .split(",")
    .map((p) => p.trim())
    .join(",");
}

function utcIso() {
  return new Date().toISOString();
}

/** Resolve rel inside root; rejects path escape. Windows-safe (no brittle startsWith on paths). */
function fileInsideRoot(root, relPath) {
  const rootR = path.resolve(root);
  const candidate = path.resolve(rootR, relPath);
  const rel = path.relative(rootR, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (candidate === rootR) return null;
  return candidate;
}

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
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".ico", "image/x-icon"],
]);

function migrateLogCsvIfNeeded() {
  try {
    if (!fs.existsSync(logFile) || fs.statSync(logFile).size === 0) return;
    const raw = fs.readFileSync(logFile, "utf8");
    const first = (raw.split(/\r?\n/)[0] || "").trim().replace(/^\uFEFF/, "");
    if (normalizeCsvHeaderLine(first) === EXPECTED_CSV_HEADER_NORM) return;
    const bak = path.join(logDir, `usage_before_schema_${utcIso().replace(/[:.]/g, "")}.csv`);
    fs.renameSync(logFile, bak);
    console.log(`Renamed old log to ${path.basename(bak)} (CSV schema updated).`);
  } catch (e) {
    console.warn("Could not migrate old usage.csv:", e.message);
  }
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function metaForEvent(e) {
  const used = new Set([
    "ts",
    "sessionId",
    "participantId",
    "participantID",
    "mode",
    "preset",
    "type",
    "tile",
    "reason",
    "href",
  ]);
  const extra = {};
  for (const k of Object.keys(e)) {
    if (!used.has(k) && e[k] !== undefined && e[k] !== null) extra[k] = e[k];
  }
  if (!Object.keys(extra).length) return "";
  return JSON.stringify(extra);
}

function ensureLogHeader() {
  fs.mkdirSync(logDir, { recursive: true });
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, CSV_FIELDS.join(",") + "\n", "utf8");
  }
}

function appendEvents(events) {
  migrateLogCsvIfNeeded();
  ensureLogHeader();
  const lines = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const pid = e.participantId ?? e.participantID ?? "";
    const row = {
      server_ts: utcIso(),
      client_ts: e.ts,
      sessionId: e.sessionId,
      participantID: pid,
      mode: e.mode ?? "",
      preset: e.preset ?? "",
      type: e.type,
      tile: e.tile,
      reason: e.reason,
      href: e.href,
      meta: metaForEvent(e),
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

migrateLogCsvIfNeeded();

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

  if (requestPath === "/__cztv__/health") {
    const junglePaths = [path.join(mediaRoot, "jungle.mp4"), path.join(webMediaRoot, "jungle.mp4")];
    let logHeader = null;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
        logHeader = fs.readFileSync(logFile, "utf8").split(/\r?\n/)[0] || null;
      }
    } catch {
      logHeader = "(read error)";
    }
    const payload = {
      ok: true,
      server: "cztv-server.js",
      mediaRoot,
      webMediaRoot,
      jungle_mp4: Object.fromEntries(
        junglePaths.map((p) => {
          try {
            return [p, fs.existsSync(p) && fs.statSync(p).isFile()];
          } catch {
            return [p, false];
          }
        })
      ),
      logFile,
      log_header_first_line: logHeader,
      expected_csv_header: EXPECTED_CSV_HEADER,
    };
    const body = JSON.stringify(payload, null, 2);
    const buf = Buffer.from(body, "utf8");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(buf.length),
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(buf);
    }
    return;
  }

  if (requestPath.startsWith("/media/")) {
    const rel = requestPath.slice("/media/".length);
    if (!rel || rel.includes("..")) {
      res.writeHead(400);
      res.end("Bad path");
      return;
    }
    let absFound = null;
    for (const base of [mediaRoot, webMediaRoot]) {
      const abs = fileInsideRoot(base, rel);
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        absFound = abs;
        break;
      }
    }
    if (!absFound) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const st = fs.statSync(absFound);
    const ext = path.extname(absFound).toLowerCase();
    res.setHeader("Content-Type", mime.get(ext) || "application/octet-stream");
    res.setHeader("Content-Length", String(st.size));
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200);
    fs.createReadStream(absFound).pipe(res);
    return;
  }

  const relPath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const abs = fileInsideRoot(webRoot, relPath);
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
  console.log(`Media search order: ${mediaRoot} then ${webMediaRoot} at /media/`);
  console.log(`Open http://localhost:${port}/`);
  console.log(`Logging POST /log -> ${logFile}`);
});
