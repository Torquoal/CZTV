#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import mimetypes
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

MEDIA_MIME = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
}

from rtsp_bridge import (
    ensure_stream,
    load_config,
    public_config,
    resolve_hls_file,
    save_config,
)


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
MEDIA_ROOT = (REPO_ROOT / "media").resolve()
LOG_DIR = REPO_ROOT / "logs"
LOG_FILE = LOG_DIR / "usage.csv"
RECORDINGS_DIR = LOG_DIR / "recordings"

# Open chunked webcam recordings: id -> {path, file, bytes}
_RECORDING_LOCK = threading.Lock()
_OPEN_RECORDINGS: dict[str, dict] = {}

CSV_FIELDS = [
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
]

EXPECTED_CSV_HEADER = ",".join(CSV_FIELDS)
EXPECTED_CSV_HEADER_NORM = ",".join(x.strip() for x in EXPECTED_CSV_HEADER.split(","))


def _normalize_csv_header_line(line: str) -> str:
    return ",".join(p.strip() for p in line.strip().lstrip("\ufeff").split(","))


def migrate_log_csv_if_needed() -> None:
    """Rotate usage.csv if header is missing or does not match the current schema."""
    if not LOG_FILE.exists() or LOG_FILE.stat().st_size == 0:
        return
    try:
        first_raw = LOG_FILE.read_text(encoding="utf-8-sig").splitlines()[0]
    except Exception:
        return
    if _normalize_csv_header_line(first_raw) == EXPECTED_CSV_HEADER_NORM:
        return
    ts = utc_iso().replace(":", "").replace("-", "")
    bak = LOG_DIR / f"usage_before_schema_{ts}.csv"
    try:
        LOG_FILE.rename(bak)
        print(f"Renamed old log to {bak.name} (CSV schema updated).")
        return
    except Exception as e:
        print(f"Rename failed for usage.csv ({e}); trying copy + reset.")
    try:
        import shutil

        shutil.copy2(LOG_FILE, bak)
        LOG_FILE.write_text(EXPECTED_CSV_HEADER + "\n", encoding="utf-8")
        print(f"Copied old log to {bak.name} and reset usage.csv (CSV schema updated).")
    except Exception as e2:
        print(f"Could not migrate old usage.csv: {e2}")


def _path_is_within(parent: Path, child: Path) -> bool:
    """Windows-safe: drive letter casing must not break containment checks."""
    try:
        par = os.path.normcase(os.path.realpath(parent))
        chi = os.path.normcase(os.path.realpath(child))
    except OSError:
        return False
    return chi == par or chi.startswith(par + os.sep)


def _join_list(value) -> str:
    if isinstance(value, list):
        return ";".join(str(x) for x in value if x is not None and str(x) != "")
    if value is None:
        return ""
    return str(value)


def event_to_row(e: dict) -> dict:
    present = e.get("present", "")
    if not present:
        present = _join_list(e.get("presentIds"))
    layout_order = e.get("layoutOrder", "")
    if isinstance(layout_order, list):
        layout_order = ";".join(str(x) for x in layout_order)
    randomize = e.get("randomizeLayout", "")
    if isinstance(randomize, bool):
        randomize = "true" if randomize else "false"
    clip_index = e.get("clipIndex", e.get("index", ""))
    if clip_index is None:
        clip_index = ""
    return {
        "server_ts": utc_iso(),
        "client_ts": e.get("ts", ""),
        "sessionId": e.get("sessionId", ""),
        "participantID": e.get("participantId", e.get("participantID", "")),
        "present": present,
        # screen = what is visible now: "wall" (4-up) or a content label (1-view)
        "screen": e.get("screen", ""),
        # event = what just happened (view_selected, idle_timeout, …)
        "event": e.get("event") or e.get("type") or "",
        "tile": e.get("tile") or e.get("slot") or "",
        "content": e.get("content") or e.get("view") or "",
        "viewId": e.get("viewId") or e.get("setId") or "",
        "reason": e.get("reason", ""),
        "url": e.get("url", ""),
        "clipFile": e.get("clipFile", "")
        or (Path(str(e.get("url", ""))).name if e.get("url") else ""),
        "familiarFile": e.get("familiarFile", ""),
        "clipIndex": clip_index,
        "layoutOrder": layout_order,
        "layoutIndex": e.get("layoutIndex", ""),
        "randomizeLayout": randomize,
        "source": e.get("source", ""),
        "message": e.get("message", ""),
        "href": e.get("href", ""),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _request_path_only(self) -> str:
        raw = self.path.split("?", 1)[0].split("#", 1)[0].replace("\\", "/")
        if not raw.startswith("/"):
            raw = "/" + raw
        return urlparse(raw if raw.startswith("http") else f"http://127.0.0.1{raw}").path

    def _media_file_for_request(self) -> Path | None:
        p = self._request_path_only()
        if not p.startswith("/media/"):
            return None
        tail = unquote(p[len("/media/") :].lstrip("/"))
        if not tail or ".." in Path(tail).parts:
            return None
        media_roots = [MEDIA_ROOT, (ROOT / "media").resolve()]
        for base in media_roots:
            try:
                base_r = base.resolve()
                candidate = (base_r / tail).resolve()
            except OSError:
                continue
            if not _path_is_within(base_r, candidate):
                continue
            if candidate.is_file():
                return candidate
        return None

    def _send_json(self, payload: dict, status: int = 200, send_body: bool = True) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_health_json(self, send_body: bool = True) -> None:
        jungle = [MEDIA_ROOT / "jungle.mp4", (ROOT / "media" / "jungle.mp4").resolve()]
        header_preview = None
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 0:
            try:
                header_preview = LOG_FILE.read_text(encoding="utf-8-sig").splitlines()[0]
            except OSError:
                header_preview = "(read error)"
        data = {
            "ok": True,
            "server": "cztv-server.py",
            "media_roots": [str(MEDIA_ROOT), str((ROOT / "media").resolve())],
            "jungle_mp4": {str(p): p.is_file() for p in jungle},
            "log_file": str(LOG_FILE),
            "recordings_dir": str(RECORDINGS_DIR),
            "log_header_first_line": header_preview,
            "expected_csv_header": EXPECTED_CSV_HEADER,
        }
        self._send_json(data, send_body=send_body)

    def _hls_file_for_request(self) -> Path | None:
        p = self._request_path_only()
        if not p.startswith("/stream/"):
            return None
        parts = [x for x in p.split("/") if x]
        if len(parts) < 3 or parts[0] != "stream":
            return None
        cam_id = parts[1]
        filename = parts[-1]
        return resolve_hls_file(cam_id, filename)

    def _send_hls_file(self, file_path: Path, only_head: bool) -> None:
        ext = file_path.suffix.lower()
        ctype = MEDIA_MIME.get(ext) or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        try:
            st = file_path.stat()
        except OSError:
            self.send_error(404)
            return
        try:
            f = file_path.open("rb")
        except OSError:
            self.send_error(404)
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(st.st_size))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if only_head:
                return
            shutil.copyfileobj(f, self.wfile)
        finally:
            f.close()

    def do_GET(self) -> None:
        path_only = self._request_path_only()
        if path_only == "/__cztv__/health":
            self._send_health_json(send_body=True)
            return
        if path_only == "/api/cameras":
            self._send_json(public_config(load_config()))
            return
        if path_only.startswith("/stream/") and path_only.endswith("/index.m3u8"):
            parts = [x for x in path_only.split("/") if x]
            if len(parts) >= 3:
                cam_id = parts[1]
                result = ensure_stream(cam_id)
                if not result.get("ok"):
                    self._send_json({"ok": False, **result}, status=503)
                    return
        hls_file = self._hls_file_for_request()
        if hls_file:
            self._send_hls_file(hls_file, only_head=False)
            return
        mp = self._media_file_for_request()
        if mp:
            self._send_media_file(mp, only_head=False)
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        path_only = self._request_path_only()
        if path_only == "/__cztv__/health":
            self._send_health_json(send_body=False)
            return
        hls_file = self._hls_file_for_request()
        if hls_file:
            self._send_hls_file(hls_file, only_head=True)
            return
        mp = self._media_file_for_request()
        if mp:
            self._send_media_file(mp, only_head=True)
            return
        super().do_HEAD()

    def _send_media_file(self, file_path: Path, only_head: bool) -> None:
        ext = file_path.suffix.lower()
        ctype = MEDIA_MIME.get(ext) or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        try:
            st = file_path.stat()
        except OSError:
            self.send_error(404)
            return
        try:
            f = file_path.open("rb")
        except OSError:
            self.send_error(404)
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(st.st_size))
            self.end_headers()
            if only_head:
                return
            shutil.copyfileobj(f, self.wfile)
        finally:
            f.close()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/cameras":
            length = int(self.headers.get("content-length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw.decode("utf-8") if raw else "{}")
            except Exception:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Bad JSON")
                return
            try:
                saved = save_config(body)
                self._send_json({"ok": True, **public_config(saved)})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=500)
            return

        if parsed.path in (
            "/api/recording",
            "/api/recording/start",
            "/api/recording/chunk",
            "/api/recording/finish",
        ):
            self._handle_recording_api(parsed)
            return

        if parsed.path != "/log":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        length = int(self.headers.get("content-length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b""

        try:
            body = json.loads(raw.decode("utf-8") if raw else "{}")
        except Exception:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Bad JSON")
            return

        events = body.get("events")
        if not isinstance(events, list):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Expected {events: []}")
            return

        migrate_log_csv_if_needed()
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_exists = LOG_FILE.exists()

        with LOG_FILE.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            if not file_exists:
                w.writeheader()

            for e in events:
                if not isinstance(e, dict):
                    continue
                w.writerow(event_to_row(e))

        self.send_response(204)
        self.end_headers()

    def _read_body_bytes(self, max_bytes: int) -> bytes | None:
        length = int(self.headers.get("content-length", "0") or "0")
        if length < 0:
            return None
        if length > max_bytes:
            # Drain a little so the client isn't left hanging worse than needed.
            try:
                self.rfile.read(min(length, 1024 * 64))
            except OSError:
                pass
            return None
        if length == 0:
            return b""
        chunks: list[bytes] = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if remaining > 0:
            return None
        return b"".join(chunks)

    def _handle_recording_api(self, parsed) -> None:
        """Chunked webcam upload: start → chunk* → finish (also accepts legacy single POST)."""
        qs = parse_qs(parsed.query or "")
        path = parsed.path

        try:
            if path == "/api/recording/start":
                self._recording_start(qs)
                return
            if path == "/api/recording/chunk":
                self._recording_chunk(qs)
                return
            if path == "/api/recording/finish":
                self._recording_finish(qs)
                return
            # Legacy whole-file upload (kept for older clients).
            self._recording_legacy_upload(qs)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, status=500)

    def _recording_start(self, qs: dict) -> None:
        session_id = (qs.get("sessionId") or [""])[0].strip()
        started_at = (qs.get("startedAt") or [""])[0].strip()
        requested = (qs.get("filename") or [""])[0].strip()
        ctype = (self.headers.get("content-type") or "video/webm").split(";")[0].strip().lower()
        ext = ".webm"
        if "mp4" in ctype:
            ext = ".mp4"
        elif "ogg" in ctype:
            ext = ".ogg"

        # Consume empty/unused body if any.
        self._read_body_bytes(1024 * 1024)

        safe = _safe_recording_filename(requested, ext)
        if not safe:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")
            sid = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64] or "session"
            safe = f"webcam_{sid}_{stamp}{ext}"

        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        out = RECORDINGS_DIR / safe
        if out.exists():
            stem = out.stem
            n = 2
            while True:
                candidate = RECORDINGS_DIR / f"{stem}_{n}{out.suffix}"
                if not candidate.exists():
                    out = candidate
                    safe = out.name
                    break
                n += 1

        rec_id = uuid.uuid4().hex
        f = out.open("wb")
        with _RECORDING_LOCK:
            _OPEN_RECORDINGS[rec_id] = {
                "path": out,
                "file": f,
                "bytes": 0,
                "sessionId": session_id,
                "startedAt": started_at,
                "filename": safe,
            }
        print(f"Opened webcam recording: {out}")
        self._send_json(
            {
                "ok": True,
                "id": rec_id,
                "filename": safe,
                "path": str(out),
                "sessionId": session_id,
                "startedAt": started_at,
            }
        )

    def _recording_chunk(self, qs: dict) -> None:
        rec_id = (qs.get("id") or [""])[0].strip()
        raw = self._read_body_bytes(32 * 1024 * 1024)
        if raw is None:
            self._send_json({"ok": False, "error": "chunk too large or incomplete"}, status=413)
            return
        with _RECORDING_LOCK:
            entry = _OPEN_RECORDINGS.get(rec_id)
            if not entry:
                self._send_json({"ok": False, "error": "unknown recording id"}, status=404)
                return
            if raw:
                entry["file"].write(raw)
                entry["file"].flush()
                entry["bytes"] += len(raw)
            total = entry["bytes"]
        self._send_json({"ok": True, "id": rec_id, "bytes": total})

    def _recording_finish(self, qs: dict) -> None:
        rec_id = (qs.get("id") or [""])[0].strip()
        # Optional final chunk in the finish body.
        raw = self._read_body_bytes(32 * 1024 * 1024)
        if raw is None:
            self._send_json({"ok": False, "error": "finish body incomplete"}, status=400)
            return
        with _RECORDING_LOCK:
            entry = _OPEN_RECORDINGS.pop(rec_id, None)
        if not entry:
            self._send_json({"ok": False, "error": "unknown recording id"}, status=404)
            return
        try:
            if raw:
                entry["file"].write(raw)
                entry["bytes"] += len(raw)
            entry["file"].flush()
            entry["file"].close()
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, status=500)
            return

        out: Path = entry["path"]
        size = entry["bytes"]
        try:
            size = out.stat().st_size
        except OSError:
            pass
        if size <= 0:
            try:
                out.unlink(missing_ok=True)
            except OSError:
                pass
            self._send_json({"ok": False, "error": "empty recording"}, status=400)
            return

        print(f"Saved webcam recording: {out} ({size} bytes)")
        self._send_json(
            {
                "ok": True,
                "id": rec_id,
                "filename": entry["filename"],
                "path": str(out),
                "bytes": size,
                "sessionId": entry.get("sessionId") or "",
                "startedAt": entry.get("startedAt") or "",
            }
        )

    def _recording_legacy_upload(self, qs: dict) -> None:
        """Single-shot whole-file upload (may fail for large videos in some browsers)."""
        requested = (qs.get("filename") or [""])[0].strip()
        session_id = (qs.get("sessionId") or [""])[0].strip()
        started_at = (qs.get("startedAt") or [""])[0].strip()

        ctype = (self.headers.get("content-type") or "video/webm").split(";")[0].strip().lower()
        ext = ".webm"
        if "mp4" in ctype:
            ext = ".mp4"
        elif "ogg" in ctype:
            ext = ".ogg"

        safe = _safe_recording_filename(requested, ext)
        if not safe:
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")
            sid = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64] or "session"
            safe = f"webcam_{sid}_{stamp}{ext}"

        raw = self._read_body_bytes(2 * 1024 * 1024 * 1024)
        if raw is None:
            self._send_json({"ok": False, "error": "recording too large or incomplete"}, status=413)
            return
        if not raw:
            self._send_json({"ok": False, "error": "empty body"}, status=400)
            return

        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        out = RECORDINGS_DIR / safe
        if out.exists():
            stem = out.stem
            n = 2
            while True:
                candidate = RECORDINGS_DIR / f"{stem}_{n}{out.suffix}"
                if not candidate.exists():
                    out = candidate
                    safe = out.name
                    break
                n += 1

        out.write_bytes(raw)
        print(f"Saved webcam recording: {out} ({len(raw)} bytes)")
        self._send_json(
            {
                "ok": True,
                "filename": safe,
                "path": str(out),
                "bytes": len(raw),
                "sessionId": session_id,
                "startedAt": started_at,
            }
        )

    def log_message(self, format, *args):
        return


def _safe_recording_filename(name: str, default_ext: str) -> str | None:
    """Allow only webcam_*.webm/mp4/ogg style names."""
    if not name:
        return None
    base = Path(name).name
    if base != name or ".." in base:
        return None
    lower = base.lower()
    if not (lower.endswith(".webm") or lower.endswith(".mp4") or lower.endswith(".ogg")):
        base = f"{base}{default_ext}"
        lower = base.lower()
    stem = Path(base).stem
    if not stem.startswith("webcam_"):
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
    if any(c not in allowed for c in base):
        return None
    return base


def main():
    port = int(os.environ.get("PORT", "8000"))
    migrate_log_csv_if_needed()
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving {ROOT}")
    print(f"Media search order: {MEDIA_ROOT} then {ROOT / 'media'} at /media/")
    print(f"Open http://localhost:{port}/")
    print(f"Logging POST /log -> {LOG_FILE}")
    print(f"Recordings POST /api/recording -> {RECORDINGS_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
