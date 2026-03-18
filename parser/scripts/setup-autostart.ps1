# Run as Administrator to set up auto-start on Windows boot

# 1. Chrome auto-start task
$chromeAction = New-ScheduledTaskAction -Execute "C:\Users\green.eldar\parser2\amazon-main\parser\scripts\chrome-start.bat"
$chromeTrigger = New-ScheduledTaskTrigger -AtLogOn -User "green.eldar"
$chromeSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "ChromeDebug" -Action $chromeAction -Trigger $chromeTrigger -Settings $chromeSettings -Description "Start Chrome with remote debugging" -Force

# 2. Parser auto-start task (delayed to wait for Chrome)
$parserAction = New-ScheduledTaskAction -Execute "C:\Users\green.eldar\parser2\amazon-main\parser\scripts\parser-start.bat"
$parserTrigger = New-ScheduledTaskTrigger -AtLogOn -User "green.eldar"
$parserTrigger.Delay = 'PT15S'
$parserSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "AmazonParser" -Action $parserAction -Trigger $parserTrigger -Settings $parserSettings -Description "Start Amazon Parser server and worker" -Force

Write-Host "Auto-start configured! Chrome and Parser will start on login."
Write-Host "To test: restart the computer or run the bat files manually."
