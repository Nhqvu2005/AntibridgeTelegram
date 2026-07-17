@echo off
title AntiBridge Telegram Bot - PM2
cd /d "%~dp0"

echo ========================================
echo   Starting AntiBridge Telegram Bot
echo   (PM2 Process Manager)
echo ========================================
echo.

:: Kiểm tra PM2 có tồn tại không
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo PM2 not found. Installing...
    call npm install -g pm2
)

:: Kiểm tra node_modules
if not exist "node_modules\dotenv" (
    echo Installing dependencies...
    call npm install
)

echo Starting bot via PM2...

pm2 start ecosystem.config.js

echo.
echo ========================================
echo   Bot started!
echo   Check status: pm2 status
echo   View logs:    pm2 logs antibridge-bot
echo   Stop bot:     stop_bot.bat
echo ========================================
echo.
echo Auto-startup is configured via Windows Startup folder.
echo Bot will start automatically when you log into Windows.
echo.
echo Done! Press any key to continue.
pause
