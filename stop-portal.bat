@echo off
chcp 65001 >nul
curl -s -m 5 -X POST http://127.0.0.1:9000/api/shutdown >nul 2>&1
if not errorlevel 1 (
  echo [stop-portal] done.
  goto :eof
)
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 9000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo [stop-portal] done.
