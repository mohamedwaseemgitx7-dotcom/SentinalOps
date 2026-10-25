@echo off
rem Double-click to run the SentinelOps web app locally on http://localhost:4600
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm ci || (pause & exit /b 1)
)
echo Building and starting SentinelOps...
start "" /b cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:4600/"
call npm start
pause
