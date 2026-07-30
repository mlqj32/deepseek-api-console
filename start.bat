@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env. Configure your DeepSeek API key in the web UI.
)
start "" "http://localhost:3217"
node server.js
pause
