@echo off
chcp 65001 >nul
cd /d "G:\platform"
echo [portal] http://localhost:9000
call npm run portal
