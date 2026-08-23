@echo off
REM Local Video Relay - Node.js launcher
setlocal
chcp 65001 >nul
cd /d "G:\tools\video"

if not exist node_modules (
  echo [start-stream] installing dependencies via npmmirror...
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)

echo [start-stream] starting local video relay on http://localhost:8100
node src/index.js
endlocal
