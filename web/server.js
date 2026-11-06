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
const recordingsDir = path.join(logDir, "recordings");

const CSV_FIELDS = [
  "server_ts",
  "client_ts",
  "sessionId",
  "participantID",
  "present",
  "screen",
  "event",
  "tile",
  "content",
  "viewId",
  "reason",
  "url",
  "clipFile",
  "familiarFile",
  "clipIndex",
  "layoutOrder",
  "layoutIndex",
  "randomizeLayout",
  "source",
  "message",
  "href",
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
    try {
      fs.renameSync(logFile, bak);
      console.log(`Renamed old log to ${path.basename(bak)} (CSV schema updated).`);
      return;
    } catch (e) {
      console.warn(`Rename failed for usage.csv (${e.message}); trying copy + reset.`);
      fs.copyFileSync(logFile, bak);
      fs.writeFileSync(logFile, EXPECTED_CSV_HEADER + "\n", "utf8");
      console.log(`Copied old log to ${path.basename(bak)} and reset usage.csv (CSV schema updated).`);
    }
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

function joinList(value) {
  if (Array.isArray(value)) return value.filter((x) => x != null && String(x) !== "").join(";");
  if (value == null) return "";
  return String(value);
}

function eventToRow(e) {
  let present = e.present ?? "";
  if (!present) present = joinList(e.presentIds);
  let layoutOrder = e.layoutOrder ?? "";
  if (Array.isArray(layoutOrder)) layoutOrder = layoutOrder.join(";");
  let randomizeLayout = e.randomizeLayout;
  if (typeof randomizeLayout === "boolean") randomizeLayout = randomizeLayout ? "true" : "false";
  else if (randomizeLayout == null) randomizeLayout = "";
  const clipIndex = e.clipIndex ?? e.index ?? "";
  let clipFile = e.clipFile ?? "";
  if (!clipFile && e.url) {
    const parts = String(e.url).split("?")[0].split("#")[0].replace(/\\/g, "/").split("/");
    clipFile = parts[parts.length - 1] || "";
  }
  return {
    server_ts: utcIso(),
    client_ts: e.ts ?? "",
    sessionId: e.sessionId ?? "",
    participantID: e.participantId ?? e.participantID ?? "",
    present,
    // screen = what is visible now: "wall" (4-up) or a content label (1-view)
    screen: e.screen ?? "",
    // event = what just happened (view_selected, idle_timeout, …)
    event: e.event || e.type || "",
    tile: e.tile || e.slot || "",
    content: e.content || e.view || "",
    viewId: e.viewId || e.setId || "",
    reason: e.reason ?? "",
    url: e.url ?? "",
    clipFile,
    familiarFile: e.familiarFile ?? "",
    clipIndex,
    layoutOrder,
    layoutIndex: e.layoutIndex ?? "",
    randomizeLayout,
    source: e.source ?? "",
    message: e.message ?? "",
    href: e.href ?? "",
  };
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
    const row = eventToRow(e);
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

function safeRecordingFilename(name, defaultExt) {
  if (!name) return null;
  const base = path.basename(name);
  if (base !== name || base.includes("..")) return null;
  let finalName = base;
  const lower = finalName.toLowerCase();
  if (!lower.endsWith(".webm") && !lower.endsWith(".mp4") && !lower.endsWith(".ogg")) {
    finalName = `${finalName}${defaultExt}`;
  }
  const stem = path.parse(finalName).name;
  if (!stem.startsWith("webcam_")) return null;
  if (!/^[a-zA-Z0-9\-_.]+$/.test(finalName)) return null;
  return finalName;
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function uniqueRecordingPath(safe) {
  let out = path.join(recordingsDir, safe);
  if (!fs.existsSync(out)) return { out, safe };
  const parsed = path.parse(safe);
  let n = 2;
  while (true) {
    const candidateName = `${parsed.name}_${n}${parsed.ext}`;
    const candidate = path.join(recordingsDir, candidateName);
    if (!fs.existsSync(candidate)) return { out: candidate, safe: candidateName };
    n += 1;
  }
}

/** @type {Map<string, { fd: number, path: string, filename: string, bytes: number, sessionId: string, startedAt: string }>} */
const openRecordings = new Map();

migrateLogCsvIfNeeded();
fs.mkdirSync(recordingsDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (
    req.method === "POST" &&
    (url.pathname === "/api/recording" ||
      url.pathname === "/api/recording/start" ||
      url.pathname === "/api/recording/chunk" ||
      url.pathname === "/api/recording/finish")
  ) {
    try {
      const sessionId = (url.searchParams.get("sessionId") || "").trim();
      const startedAt = (url.searchParams.get("startedAt") || "").trim();
      const requested = (url.searchParams.get("filename") || "").trim();
      const ctype = String(req.headers["content-type"] || "video/webm")
        .split(";")[0]
        .trim()
        .toLowerCase();
      let ext = ".webm";
      if (ctype.includes("mp4")) ext = ".mp4";
      else if (ctype.includes("ogg")) ext = ".ogg";

      if (url.pathname === "/api/recording/start") {
        await readBody(req);
        let safe = safeRecordingFilename(requested, ext);
        if (!safe) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "");
          const sid = (sessionId.replace(/[^a-zA-Z0-9\-_]/g, "") || "session").slice(0, 64);
          safe = `webcam_${sid}_${stamp}${ext}`;
        }
        fs.mkdirSync(recordingsDir, { recursive: true });
        const uniq = uniqueRecordingPath(safe);
        const fd = fs.openSync(uniq.out, "w");
        const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        openRecordings.set(id, {
          fd,
          path: uniq.out,
          filename: uniq.safe,
          bytes: 0,
          sessionId,
          startedAt,
        });
        console.log(`Opened webcam recording: ${uniq.out}`);
        sendJson(res, 200, {
          ok: true,
          id,
          filename: uniq.safe,
          path: uniq.out,
          sessionId,
          startedAt,
        });
        return;
      }

      if (url.pathname === "/api/recording/chunk") {
        const id = (url.searchParams.get("id") || "").trim();
        const raw = await readBody(req);
        const entry = openRecordings.get(id);
        if (!entry) {
          sendJson(res, 404, { ok: false, error: "unknown recording id" });
          return;
        }
        if (raw.length) {
          fs.writeSync(entry.fd, raw);
          entry.bytes += raw.length;
        }
        sendJson(res, 200, { ok: true, id, bytes: entry.bytes });
        return;
      }

      if (url.pathname === "/api/recording/finish") {
        const id = (url.searchParams.get("id") || "").trim();
        const raw = await readBody(req);
        const entry = openRecordings.get(id);
        if (!entry) {
          sendJson(res, 404, { ok: false, error: "unknown recording id" });
          return;
        }
        openRecordings.delete(id);
        if (raw.length) {
          fs.writeSync(entry.fd, raw);
          entry.bytes += raw.length;
        }
        fs.closeSync(entry.fd);
        let size = entry.bytes;
        try {
          size = fs.statSync(entry.path).size;
        } catch {
          /* ignore */
        }
        if (size <= 0) {
          try {
            fs.unlinkSync(entry.path);
          } catch {
            /* ignore */
          }
          sendJson(res, 400, { ok: false, error: "empty recording" });
          return;
        }
        console.log(`Saved webcam recording: ${entry.path} (${size} bytes)`);
        sendJson(res, 200, {
          ok: true,
          id,
          filename: entry.filename,
          path: entry.path,
          bytes: size,
          sessionId: entry.sessionId,
          startedAt: entry.startedAt,
        });
        return;
      }

      // Legacy whole-file upload.
      let safe = safeRecordingFilename(requested, ext);
      if (!safe) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "");
        const sid = (sessionId.replace(/[^a-zA-Z0-9\-_]/g, "") || "session").slice(0, 64);
        safe = `webcam_${sid}_${stamp}${ext}`;
      }
      const raw = await readBody(req);
      if (!raw.length) {
        sendJson(res, 400, { ok: false, error: "empty body" });
        return;
      }
      fs.mkdirSync(recordingsDir, { recursive: true });
      const uniq = uniqueRecordingPath(safe);
      fs.writeFileSync(uniq.out, raw);
      console.log(`Saved webcam recording: ${uniq.out} (${raw.length} bytes)`);
      sendJson(res, 200, {
        ok: true,
        filename: uniq.safe,
        path: uniq.out,
        bytes: raw.length,
        sessionId,
        startedAt,
      });
      return;
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }
  }

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
      recordingsDir,
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
  console.log(`Recordings POST /api/recording -> ${recordingsDir}`);
});
