"""RTSP → HLS bridge via ffmpeg for browser playback."""
from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
CAMERAS_LOCAL = ROOT / "cameras.local.json"
CAMERAS_EXAMPLE = ROOT / "cameras.example.json"
HLS_ROOT = ROOT / ".hls-cache"

DEFAULT_CONFIG: dict = {
    "cameras": [
        {
            "id": "cam1",
            "label": "Camera 1",
            "host": "",
            "path": "/stream1",
            "username": "",
            "password": "",
        },
        {
            "id": "cam2",
            "label": "Camera 2",
            "host": "",
            "path": "/stream1",
            "username": "",
            "password": "",
        },
        {
            "id": "cam3",
            "label": "Camera 3",
            "host": "",
            "path": "/stream1",
            "username": "",
            "password": "",
        },
        {
            "id": "cam4",
            "label": "Camera 4",
            "host": "",
            "path": "/stream1",
            "username": "",
            "password": "",
        },
    ],
    "tileMap": [0, 1, 2, 3],
}

_lock = threading.Lock()
_processes: dict[str, subprocess.Popen] = {}


def find_ffmpeg() -> str | None:
    env = os.environ.get("FFMPEG_PATH", "").strip()
    if env and Path(env).is_file():
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in (
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe",
        Path("C:/ffmpeg/bin/ffmpeg.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    tools_root = ROOT / ".tools"
    if tools_root.is_dir():
        for candidate in tools_root.rglob("ffmpeg.exe"):
            if candidate.is_file():
                return str(candidate)
    return None


def default_config() -> dict:
    import copy

    return copy.deepcopy(DEFAULT_CONFIG)


def _normalize_camera(raw: dict, idx: int) -> dict:
    cam_id = str(raw.get("id") or f"cam{idx + 1}").strip() or f"cam{idx + 1}"
    path = str(raw.get("path") or "/stream1").strip() or "/stream1"
    if not path.startswith("/"):
        path = "/" + path
    return {
        "id": cam_id,
        "label": str(raw.get("label") or f"Camera {idx + 1}").strip() or f"Camera {idx + 1}",
        "host": str(raw.get("host") or "").strip(),
        "path": path,
        "username": str(raw.get("username") or ""),
        "password": str(raw.get("password") or ""),
    }


def normalize_config(raw: dict | None) -> dict:
    if not isinstance(raw, dict):
        return default_config()
    cameras_in = raw.get("cameras")
    if not isinstance(cameras_in, list) or not cameras_in:
        cameras_in = [raw]
    cameras = [_normalize_camera(c if isinstance(c, dict) else {}, i) for i, c in enumerate(cameras_in[:4])]
    if not cameras:
        cameras = [_normalize_camera({}, 0)]
    tile_map = raw.get("tileMap")
    if not isinstance(tile_map, list) or len(tile_map) != 4:
        tile_map = [0, 0, 0, 0]
    max_idx = max(0, len(cameras) - 1)

    def _tile_index(x) -> int:
        try:
            val = int(x)
        except (TypeError, ValueError):
            return 0
        return max(0, min(max_idx, val))

    tile_map = [_tile_index(x) for x in tile_map]
    return {"cameras": cameras, "tileMap": tile_map}


def load_config() -> dict:
    for path in (CAMERAS_LOCAL, CAMERAS_EXAMPLE):
        if not path.is_file():
            continue
        try:
            import json

            data = json.loads(path.read_text(encoding="utf-8"))
            return normalize_config(data)
        except Exception:
            continue
    return default_config()


def save_config(raw: dict) -> dict:
    import json

    existing = {c["id"]: c for c in load_config()["cameras"]}
    cfg = normalize_config(raw)
    for cam in cfg["cameras"]:
        if not cam["password"] and cam["id"] in existing:
            cam["password"] = existing[cam["id"]].get("password", "")
    CAMERAS_LOCAL.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    restart_all_streams()
    return cfg


def public_config(cfg: dict | None = None) -> dict:
    cfg = normalize_config(cfg or load_config())
    cameras = []
    for cam in cfg["cameras"]:
        cameras.append(
            {
                "id": cam["id"],
                "label": cam["label"],
                "host": cam["host"],
                "path": cam["path"],
                "username": cam["username"],
                "hasPassword": bool(cam["password"]),
                "streamUrl": f"/stream/{cam['id']}/index.m3u8",
            }
        )
    return {
        "cameras": cameras,
        "tileMap": cfg["tileMap"],
        "tileUrls": [
            cameras[i]["streamUrl"] if i < len(cameras) and cameras[i]["host"] else ""
            for i in cfg["tileMap"]
        ],
        "ffmpeg": find_ffmpeg() is not None,
        "ffmpegPath": find_ffmpeg(),
    }


def rtsp_url(cam: dict) -> str:
    host = cam["host"].strip()
    path = cam["path"]
    user = cam.get("username") or ""
    pwd = cam.get("password") or ""
    if user:
        auth = f"{quote(user, safe='')}:{quote(pwd, safe='')}"
        return f"rtsp://{auth}@{host}{path}"
    return f"rtsp://{host}{path}"


def hls_dir(cam_id: str) -> Path:
    return HLS_ROOT / cam_id


def stop_stream(cam_id: str) -> None:
    proc = _processes.pop(cam_id, None)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def stop_all_streams() -> None:
    with _lock:
        for cam_id in list(_processes.keys()):
            stop_stream(cam_id)


def restart_all_streams() -> None:
    stop_all_streams()


def _spawn_ffmpeg(cam: dict) -> subprocess.Popen | None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    if not cam.get("host"):
        return None

    out_dir = hls_dir(cam["id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*"):
        try:
            old.unlink()
        except OSError:
            pass

    playlist = out_dir / "index.m3u8"
    segment_pattern = str(out_dir / "seg_%03d.ts")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url(cam),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-g",
        "30",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "4",
        "-hls_flags",
        "delete_segments+append_list+omit_endlist+program_date_time",
        "-hls_segment_filename",
        segment_pattern,
        str(playlist),
    ]
    log_file = out_dir / "ffmpeg.log"
    err_fh = open(log_file, "a", encoding="utf-8")
    err_fh.write(f"\n--- spawn {time.time()} ---\n")
    err_fh.flush()
    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=err_fh,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def ensure_stream(cam_id: str) -> dict:
    cfg = load_config()
    cam = next((c for c in cfg["cameras"] if c["id"] == cam_id), None)
    if not cam:
        return {"ok": False, "error": "unknown_camera"}
    if not find_ffmpeg():
        return {"ok": False, "error": "ffmpeg_missing"}
    if not cam.get("host"):
        return {"ok": False, "error": "host_missing"}

    with _lock:
        proc = _processes.get(cam_id)
        if proc and proc.poll() is None:
            return {"ok": True, "status": "running"}

        stop_stream(cam_id)
        proc = _spawn_ffmpeg(cam)
        if not proc:
            return {"ok": False, "error": "spawn_failed"}
        _processes[cam_id] = proc

    playlist = hls_dir(cam_id) / "index.m3u8"
    for _ in range(40):
        if playlist.is_file() and playlist.stat().st_size > 0:
            return {"ok": True, "status": "started"}
        if proc.poll() is not None:
            return {"ok": False, "error": "ffmpeg_exited", "log": str(hls_dir(cam_id) / "ffmpeg.log")}
        time.sleep(0.25)
    return {"ok": False, "error": "playlist_timeout", "log": str(hls_dir(cam_id) / "ffmpeg.log")}


def resolve_hls_file(cam_id: str, filename: str) -> Path | None:
    if not cam_id or ".." in cam_id or "/" in cam_id or "\\" in cam_id:
        return None
    if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
        return None
    candidate = (hls_dir(cam_id) / filename).resolve()
    base = hls_dir(cam_id).resolve()
    try:
        if os.path.commonpath([str(base), str(candidate)]) != str(base):
            return None
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


atexit.register(stop_all_streams)
