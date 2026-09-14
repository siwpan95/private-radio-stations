@echo off
chcp 65001 >nul
rem Paths are always relative to this file via %~dp0 - never hardcode a
rem drive letter. This repo has moved G: -> D: -> C: and every hardcoded
rem absolute path silently broke on each move.
cd /d "%~dp0"
call apps\video\stop-stream.bat
