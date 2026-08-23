@echo off
REM Local Video Relay - graceful stopper
setlocal
chcp 65001 >nul
cd /d "G:\tools\video"

echo [stop-stream] requesting graceful shutdown...
curl -s -m 5 -X POST http://127.0.0.1:8100/api/shutdown >nul 2>&1
if not errorlevel 1 (
  timeout /t 2 /nobreak >nul
  echo [stop-stream] service stopped.
  goto end
)

echo [stop-stream] API not responding, force-stopping project processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src/index.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
taskkill /f /im mediamtx.exe >nul 2>&1
taskkill /f /im ffmpeg.exe >nul 2>&1
echo [stop-stream] done.

:end
endlocal
