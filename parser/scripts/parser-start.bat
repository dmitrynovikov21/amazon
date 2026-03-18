@echo off
:: Start Amazon Parser (server + worker)
cd /d C:\Users\green.eldar\parser2\amazon-main\parser

:: Start server in new window
start "Parser Server" node server.js

:: Wait 3 seconds for server to initialize
timeout /t 3 /nobreak >nul

:: Start worker in new window
start "Parser Worker" node worker.js

echo Parser started! Server on http://localhost:8080
