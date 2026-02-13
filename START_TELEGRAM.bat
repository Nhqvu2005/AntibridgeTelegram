@echo off
echo ========================================
echo   AntiBridge - Telegram Mode
echo ========================================
echo.

echo Waiting 5 seconds for Antigravity to start...
timeout /t 5 /nobreak >nul

cd /d "%~dp0"

:loop
echo.
echo [%date% %time%] Starting Telegram Server...
echo.

:: Pull latest code before starting
git pull origin main 2>nul

node backend/telegram-server.js

echo.
echo [%date% %time%] Bot exited. Restarting in 3 seconds...
echo   (Press Ctrl+C to stop)
timeout /t 3 /nobreak >nul
goto loop
