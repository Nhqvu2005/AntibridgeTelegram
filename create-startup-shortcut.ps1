$shortcutPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\AntibridgeBot.lnk"
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }
$WS = New-Object -ComObject WScript.Shell
$SC = $WS.CreateShortcut($shortcutPath)
$SC.TargetPath = "E:\AntibridgeTelegram\pm2-startup-helper.bat"
$SC.WorkingDirectory = "E:\AntibridgeTelegram"
$SC.WindowStyle = 7
$SC.Save()
Write-Host "Done"
