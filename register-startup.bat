@echo off
:: Register PM2 startup task in Windows Task Scheduler
:: Run this as Administrator ONCE to enable auto-start on boot

cd /d "E:\AntibridgeTelegram"

schtasks /create /tn "AntibridgeTelegramBot" /tr "cmd.exe /c \"C:\Users\PC\AppData\Roaming\npm\pm2.cmd resurrect\"" /sc onlogon /ru "%USERNAME%" /rl highest /f

if %errorlevel% equ 0 (
    echo.
    echo ✅ Task created successfully!
    echo Bot will auto-start when you log into Windows.
) else (
    echo.
    echo ⚠️ Failed to create scheduled task.
    echo Make sure to run this batch file AS ADMINISTRATOR.
    echo.
    echo Alternative: press Win+R, type: shell:startup
    echo Then create a shortcut to pm2-startup-helper.bat in that folder.
)

pause
