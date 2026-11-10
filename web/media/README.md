# Local media copy

When you run `serve.ps1`, it syncs `../media` video files (including `familiar/` and `unfamiliar/` subfolders) into this folder so `http://localhost:8000/media/…` works.

## B-roll folders

- `familiar/` — familiar chimpanzee clips
- `unfamiliar/` — unfamiliar chimpanzee clips

The wall discovers clips via `GET /api/video-sets` and shuffles playback order.

**Format note:** `.mp4` (H.264) is the reliable choice for Chrome/Edge kiosk playback. `.mov` is served and listed, but many Chromium browsers will not play QuickTime `.mov` — convert those to `.mp4` when possible.

## Start screen

The wall shows `placeholder.png` as the full-screen home image until the display is tapped (or returns to it when you press `b`).
