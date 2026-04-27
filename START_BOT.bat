@echo off
setlocal

title AntiBridge Telegram Bot - Safe Startup

echo ========================================
echo   AntiBridge Telegram Bot - Safe Mode
echo ========================================
echo.

cd /d "%~dp0"

echo Checking dependencies...
if not exist "node_modules\dotenv" (
    echo Missing node_modules or dotenv. Running npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Please check network/npm setup.
        pause
        exit /b 1
    )
) else (
    echo Dependencies OK.
)

:loop
echo.
echo [%date% %time%] Starting Telegram Bot via safe-startup...
echo.

node backend\safe-startup.js >> bot_crash_log.txt 2>&1

echo.
echo [%date% %time%] Bot exited. Restarting in 3 seconds...
echo   Log file: %~dp0bot_crash_log.txt
echo   Press Ctrl+C to stop.
timeout /t 3 /nobreak >nul
goto loop
