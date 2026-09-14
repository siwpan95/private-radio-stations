@echo off
chcp 65001 >nul
rem Start localplayer-bridge: expose this project's media sources as the
rem /api/list contract consumed by the "lightweight player" Chrome/Edge extension.
rem
rem Paths are always relative to this file via %~dp0 - never hardcode a drive
rem letter. This repo has moved G: -> D: -> C: and every hardcoded absolute
rem path silently broke on each move.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERR] node not found. Node.js 18+ is required (needs global fetch).
  pause & exit /b 1
)

echo Starting localplayer-bridge on http://127.0.0.1:8787
echo   list   http://127.0.0.1:8787/api/list
echo   health http://127.0.0.1:8787/api/health
echo   stop   press Ctrl+C in this window
echo.
node scripts\localplayer-bridge.mjs
pause
