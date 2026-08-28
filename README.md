# CZTV (Chimp Zoo TV) — 4‑camera touchscreen panel

Goal: a touchscreen-friendly “video wall” showing **4 feeds** (2×2) where a chimp (or operator) can **tap one panel to maximize** and tap again to return to 4‑up.

This repo starts with a minimal UI prototype. Next we’ll integrate live camera feeds and recorded playback.

## Constraints / assumptions

- Cameras likely connect over **Wi‑Fi** (30–80 m, complex geometry).
- Prefer **no extra bridge hardware/services** beyond the central client device.
- Central client can be a **kiosk app** or a **web app** (we’ll choose based on what the cameras can output).

## Prototype UI

- `web/index.html`: static, dependency-free UI:
  - 4-up grid
  - tap a tile to maximize
  - tap again (or press `Esc`) to return

Run it by opening `web/index.html` in a browser.

## POC: webcam mirror

The first proof-of-concept skips the Tapo C420 entirely (battery models do not expose RTSP/ONVIF) and just mirrors **one local USB webcam** into all four tiles, so we can validate the touchscreen wall UX end-to-end before tackling real camera integration.

UI note:

- The chimp-facing screen is intentionally **textless** (just the 2×2 video wall). On load, it **auto-attempts** to start the camera; if the browser requires a user gesture for permission, a single full-screen **Start camera** button appears for the researcher, and disappears once the camera is live.
- Basic usage events (maximize/minimize) are logged locally and also POSTed to the local server, which appends them to `logs/usage.csv`.

How to run:

1. Plug in a USB webcam.
2. Start a local server from the `web/` folder:
   - PowerShell:
     - `cd web`
     - `.\serve.ps1` (or double-click `web/serve.cmd`)
3. Open `http://localhost:8000/` in Chrome/Edge/Firefox.
4. If prompted, click **Start camera** and grant camera permission.
5. Usage data will be written to `logs/usage.csv` while the app runs.

Notes:

- Uses `navigator.mediaDevices.getUserMedia` only — no server, no bridge, no extra dependencies.
- Browsers normally require **HTTPS or `localhost`** for camera access, which is why we serve it locally.
- Mirroring one stream into four `<video>` elements only opens the camera once.

Deferred:

- Tapo C420 integration (vendor-app/cloud path or hub) — revisit later.
- Multi-camera selection, recorded playback, kiosk packaging, and any RTSP/ONVIF cameras.

