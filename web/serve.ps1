param(
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Warn([string]$msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host $msg -ForegroundColor Red }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$mediaSrc = Join-Path $scriptDir "..\media"
$mediaDst = Join-Path $scriptDir "media"
if (Test-Path $mediaSrc) {
  New-Item -ItemType Directory -Force -Path $mediaDst | Out-Null
  Copy-Item -Path (Join-Path $mediaSrc "*.mp4") -Destination $mediaDst -Force -ErrorAction SilentlyContinue
  Write-Info "Synced *.mp4 from ..\media into web\media (helps /media/ and plain static servers)."
} else {
  Write-Warn "Folder not found: $mediaSrc - recorded /media/*.mp4 may 404 unless files exist in web\media."
}

Write-Info "Serving CZTV web prototype from:"
Write-Host "  $scriptDir"
Write-Host ""
Write-Info "Open:"
Write-Host "  http://localhost:$Port/"
Write-Host ""

try {
  $python = Get-Command python -ErrorAction Stop
  Write-Info "Using Python: $($python.Source)"
  $env:PORT = "$Port"
  python ".\server.py"
  exit $LASTEXITCODE
} catch {
  Write-Warn "Python not found on PATH."
}

try {
  $py = Get-Command py -ErrorAction Stop
  Write-Info "Using Python Launcher: $($py.Source)"
  $env:PORT = "$Port"
  py ".\server.py"
  exit $LASTEXITCODE
} catch {
  Write-Warn "Python Launcher (py) not found on PATH."
}

try {
  $node = Get-Command node -ErrorAction Stop
  Write-Info "Using Node: $($node.Source)"
  $env:PORT = "$Port"
  Write-Info "Starting a tiny local server..."
  node ".\server.js"
  exit $LASTEXITCODE
} catch {
  Write-Warn "Node not found on PATH."
}

Write-Err "Could not start a local server."
Write-Host "Install Python (recommended) or Node, then re-run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\\serve.ps1"
exit 1

