@echo off
REM SOKONI Print Bridge — starts the local bridge that carries SOKONI receipts to a Wi-Fi / LAN printer.
REM Requires Node.js 18 or newer (https://nodejs.org). Leave this window open while you sell.
REM It listens ONLY on this computer (http://127.0.0.1:9101) and prints only for signed-in SOKONI pages.
cd /d "%~dp0"
node --version >nul 2>&1 || (echo Node.js is not installed. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
node bridge.js
pause
