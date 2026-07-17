@echo off
title AntiBridge Telegram Bot - Stop
cd /d "%~dp0"

echo ========================================
echo   Stopping AntiBridge Telegram Bot
echo ========================================
echo.

:: Kiểm tra PM2 có tồn tại không
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: PM2 not found. Bot is not managed by PM2.
    pause
    exit /b 1
)

pm2 stop antibridge-bot
pm2 delete antibridge-bot

echo.
echo ========================================
echo   Bot stopped successfully!
echo   Use start_bot.bat to start again.
echo ========================================
pause
