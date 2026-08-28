@echo off
REM Local Video Relay - graceful stopper
rem Fallback (2026-08-28): tree-kill the exact 8100 listener by port. The old
rem 'src/index.js' pattern match could kill the caller (CLI/portal) itself, and
rem 'taskkill /im mediamtx.exe /im ffmpeg.exe' killed unrelated machine-wide processes.
rem NOTE: keep this file ASCII-only; Chinese comments misparse under GBK consoles.
setlocal
chcp 65001 >nul

echo [stop-stream] requesting graceful shutdown...
curl -s -m 5 -X POST http://127.0.0.1:8100/api/shutdown >nul 2>&1
if not errorlevel 1 (
  echo [stop-stream] service stopped.
  goto end
)

echo [stop-stream] API not responding, force-stopping port 8100 listener tree...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8100 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }" >nul 2>&1
echo [stop-stream] done.

:end
endlocal
