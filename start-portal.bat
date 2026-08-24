@echo off
chcp 65001 >nul
cd /d "G:\tools\private-radio-stations\apps\portal"
echo [portal] http://localhost:9000
node src/index.js
