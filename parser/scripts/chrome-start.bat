@echo off
:: Start Chrome with remote debugging and persistent profile
:: Session (cookies, login) is saved in user-data-dir
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\green.eldar\chrome-parser-profile" ^
  --restore-last-session ^
  --no-first-run ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  "https://sellercentral.amazon.com"
