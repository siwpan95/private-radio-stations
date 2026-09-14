@echo off
chcp 65001 >nul
rem Paths are always relative to this file via %~dp0 - never hardcode a
rem drive letter. This repo has moved G: -> D: -> C: and every hardcoded
rem absolute path silently broke on each move.
cd /d "%~dp0..\..\platform"
if errorlevel 1 (
  echo [portal] cannot find the platform directory: "%~dp0..\..\platform"
  echo [portal] expected layout: ...\platform  next to  ...\private-radio-stations
  pause & exit /b 1
)
echo [portal] http://localhost:9000
call npm run portal
