#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
LOG_DIR = REPO_ROOT / "logs"
LOG_FILE = LOG_DIR / "usage.csv"


CSV_FIELDS = [
    "server_ts",
    "client_ts",
    "sessionId",
    "type",
    "tile",
    "reason",
    "href",
]


class Handler(SimpleHTTPRequestHandler):
    # Serve files from web/ directory
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
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

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_exists = LOG_FILE.exists()

        with LOG_FILE.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            if not file_exists:
                w.writeheader()

            for e in events:
                if not isinstance(e, dict):
                    continue
                w.writerow(
                    {
                        "server_ts": utc_iso(),
                        "client_ts": e.get("ts"),
                        "sessionId": e.get("sessionId"),
                        "type": e.get("type"),
                        "tile": e.get("tile"),
                        "reason": e.get("reason"),
                        "href": e.get("href"),
                    }
                )

        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        # Keep console quiet for kiosk use.
        return


def main():
    port = int(os.environ.get("PORT", "8000"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving {ROOT}")
    print(f"Open http://localhost:{port}/")
    print(f"Logging POST /log -> {LOG_FILE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

