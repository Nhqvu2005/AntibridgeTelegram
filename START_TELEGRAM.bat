@echo off
echo ========================================
echo   AntiBridge - Telegram Mode
echo ========================================
echo.

echo.
echo Waiting 5 seconds for Antigravity to start...
timeout /t 5 /nobreak >nul

echo.
echo Step 2: Starting Telegram Server...
cd /d "%~dp0"
node backend/telegram-server.js
