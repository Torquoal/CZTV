param(
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Warn([string]$msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host $msg -ForegroundColor Red }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Info "Serving CZTV web prototype from:"
Write-Host "  $scriptDir"
Write-Host ""
Write-Info "Open:"
Write-Host "  http://localhost:$Port/"
Write-Host ""

try {
  $python = Get-Command python -ErrorAction Stop
  Write-Info "Using Python: $($python.Source)"
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
  Write-Info "Starting a tiny local server…"
  node ".\server.js"
  exit $LASTEXITCODE
} catch {
  Write-Warn "Node not found on PATH."
}

Write-Err "Couldn't start a local server."
Write-Host "Install Python (recommended) or Node, then re-run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\\serve.ps1"
exit 1

