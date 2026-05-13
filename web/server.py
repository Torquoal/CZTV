#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import mimetypes
import os
import shutil
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

MEDIA_MIME = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
}


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
MEDIA_ROOT = (REPO_ROOT / "media").resolve()
LOG_DIR = REPO_ROOT / "logs"
LOG_FILE = LOG_DIR / "usage.csv"

CSV_FIELDS = [
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
    except Exception as e:
        print(f"Could not migrate old usage.csv: {e}")


def _path_is_within(parent: Path, child: Path) -> bool:
    """Windows-safe: drive letter casing must not break containment checks."""
    try:
        par = os.path.normcase(os.path.realpath(parent))
        chi = os.path.normcase(os.path.realpath(child))
    except OSError:
        return False
    return chi == par or chi.startswith(par + os.sep)


def meta_for_event(e: dict) -> str:
    used = {
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
    }
    extra = {k: v for k, v in e.items() if k not in used and v is not None}
    if not extra:
        return ""
    return json.dumps(extra, separators=(",", ":"), ensure_ascii=False)


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

    def _send_health_json(self, send_body: bool = True) -> None:
        import json as _json

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
            "log_header_first_line": header_preview,
            "expected_csv_header": EXPECTED_CSV_HEADER,
        }
        body = _json.dumps(data, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def do_GET(self) -> None:
        if self._request_path_only() == "/__cztv__/health":
            self._send_health_json(send_body=True)
            return
        mp = self._media_file_for_request()
        if mp:
            self._send_media_file(mp, only_head=False)
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if self._request_path_only() == "/__cztv__/health":
            self._send_health_json(send_body=False)
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
                pid = e.get("participantId", e.get("participantID", ""))
                w.writerow(
                    {
                        "server_ts": utc_iso(),
                        "client_ts": e.get("ts"),
                        "sessionId": e.get("sessionId"),
                        "participantID": pid,
                        "mode": e.get("mode", ""),
                        "preset": e.get("preset", ""),
                        "type": e.get("type"),
                        "tile": e.get("tile"),
                        "reason": e.get("reason"),
                        "href": e.get("href"),
                        "meta": meta_for_event(e),
                    }
                )

        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        return


def main():
    port = int(os.environ.get("PORT", "8000"))
    migrate_log_csv_if_needed()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving {ROOT}")
    print(f"Media search order: {MEDIA_ROOT} then {ROOT / 'media'} at /media/")
    print(f"Open http://localhost:{port}/")
    print(f"Logging POST /log -> {LOG_FILE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
