@echo off
:: PM2 startup helper — chạy khi Windows khởi động
:: Được gọi bởi Windows Task Scheduler
cd /d "E:\AntibridgeTelegram"

:: Đợi network/user ready
timeout /t 5 /nobreak >nul

:: Khởi động PM2 resurrect để phục hồi các process đã save
C:\Users\PC\AppData\Roaming\npm\pm2.cmd resurrect

:: Nếu resurrect thất bại (chưa có dump), chạy từ ecosystem
if %errorlevel% neq 0 (
    C:\Users\PC\AppData\Roaming\npm\pm2.cmd start ecosystem.config.js
    C:\Users\PC\AppData\Roaming\npm\pm2.cmd save
)
