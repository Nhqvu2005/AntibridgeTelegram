@echo off
cd /d "%~dp0"
:: Claude Sync — chạy claude với session ID dùng chung giữa Telegram và local
:: Đọc session ID từ .claude-sync-session, tạo mới nếu chưa có

setlocal enabledelayedexpansion

if not exist ".claude-sync-session" (
    :: Tạo UUID v4
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString()"') do set uuid=%%a
    echo !uuid!> .claude-sync-session
    echo ^🔑 Created shared session ID: !uuid!
) else (
    set /p uuid=< .claude-sync-session
)

echo ^📝 Session ID: %uuid%
echo.
claude --session-id %uuid% %*
