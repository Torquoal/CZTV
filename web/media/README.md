# Local media copy

When you run `serve.ps1`, it copies `../media/*.mp4` into this folder so `http://localhost:8000/media/…` works even if the dev server does not map `/media/` to the repo root.

These files are listed in `.gitignore` so they are not committed.
