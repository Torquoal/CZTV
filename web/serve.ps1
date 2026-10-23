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

$ffmpegLocal = Get-ChildItem -Path (Join-Path $scriptDir ".tools") -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffmpegLocal) {
  $env:FFMPEG_PATH = $ffmpegLocal.FullName
  Write-Info "Using bundled ffmpeg: $($ffmpegLocal.FullName)"
} else {
  $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffmpegCmd) {
    Write-Info "Using ffmpeg: $($ffmpegCmd.Source)"
  } else {
    Write-Warn "ffmpeg not found. Network camera mode needs ffmpeg (winget install Gyan.FFmpeg, or place ffmpeg under web\.tools)."
  }
}

function Test-RealPython([string]$exe, [string[]]$prefixArgs = @()) {
  # Windows App Execution Aliases look like python.exe but only open the Store.
  if ($exe -match '\\WindowsApps\\') { return $false }
  try {
    $null = & $exe @prefixArgs -c "import sys; print(sys.version)" 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Resolve-PythonExe {
  $candidates = @()
  $candidates += @(Get-Command python -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $candidates += @(
    "$env:LOCALAPPDATA\Python\bin\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
  )
  foreach ($c in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if ((Test-Path $c) -and (Test-RealPython $c)) { return $c }
  }
  return $null
}

$env:PORT = "$Port"

$pythonExe = Resolve-PythonExe
if ($pythonExe) {
  Write-Info "Using Python: $pythonExe"
  & $pythonExe ".\server.py"
  exit $LASTEXITCODE
}
Write-Warn "Python not found on PATH (or only the Windows Store stub)."

$py = Get-Command py -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch '\\WindowsApps\\' } | Select-Object -First 1
if ($py -and (Test-RealPython $py.Source @("-3"))) {
  Write-Info "Using Python Launcher: $($py.Source)"
  & $py.Source -3 ".\server.py"
  exit $LASTEXITCODE
}
Write-Warn "Python Launcher (py) not found on PATH."

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Info "Using Node: $($node.Source)"
  Write-Info "Starting a tiny local server..."
  & $node.Source ".\server.js"
  exit $LASTEXITCODE
}
Write-Warn "Node not found on PATH."

Write-Err "Could not start a local server."
Write-Host "Install Python (recommended) or Node, then re-run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\\serve.ps1"
exit 1

