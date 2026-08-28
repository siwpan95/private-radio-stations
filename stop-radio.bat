@echo off
rem Graceful stop for radio (port 8000): request the service's own /api/shutdown.
rem Fallback (2026-08-28): tree-kill the exact 8000 listener by port. The old
rem 'src/index.js' pattern match could kill the caller (CLI/portal) itself, and
rem 'taskkill /im ffmpeg.exe' killed unrelated machine-wide processes.
rem NOTE: keep this file ASCII-only; Chinese comments misparse under GBK consoles.
chcp 65001 >nul
curl -s -m 5 -X POST http://127.0.0.1:8000/api/shutdown >nul 2>&1
if not errorlevel 1 (
  echo [stop-radio] graceful shutdown requested.
  exit /b 0
)
echo [stop-radio] API not responding, force-stopping port 8000 listener tree...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }" >nul 2>&1
echo [stop-radio] done.
