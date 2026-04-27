@echo off
REM Deprecated compatibility entry point.
REM Use START_BOT.bat as the single canonical startup file.
cd /d "%~dp0"
call "%~dp0START_BOT.bat"
