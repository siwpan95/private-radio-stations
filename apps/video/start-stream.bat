@echo off
REM Local Video Relay - Node.js launcher
setlocal
chcp 65001 >nul
cd /d "G:\tools\private-radio-stations\apps\video"

REM --- already running? (our own instance answers /api/status) ---
curl -s -o nul -m 2 http://127.0.0.1:8100/api/status
if not errorlevel 1 (
  echo [start-stream] service already running: http://localhost:8100
  start "" http://localhost:8100
  goto end
)

REM --- port taken by something else? ---
netstat -ano | findstr ":8100" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [start-stream] port 8100 is in use by another program:
  netstat -ano | findstr ":8100" | findstr "LISTENING"
  echo [start-stream] close that program first, or edit port in cordis.yml
  goto end
)

if not exist node_modules (
  echo [start-stream] installing dependencies via npmmirror...
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)

echo [start-stream] starting local video relay on http://localhost:8100
node src/index.js

:end
endlocal
