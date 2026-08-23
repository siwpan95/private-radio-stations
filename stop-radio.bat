@echo off
chcp 65001 >nul
cd /d "G:\tools\private-radio-stations"
curl -s -m 5 -X POST http://127.0.0.1:8000/api/shutdown >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src/index.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  taskkill /f /im ffmpeg.exe >nul 2>&1
)
echo [stop-radio] done.
