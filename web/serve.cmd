@echo off
setlocal

REM Simple wrapper so you can double-click to run.
REM Runs PowerShell script in the same folder.

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%serve.ps1"

