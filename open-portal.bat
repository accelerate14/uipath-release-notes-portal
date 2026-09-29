@echo off
REM Release Radar v1.2 - open the portal on this PC with the analysis that is already published.
REM No UiPath token and no agent calls. Use start-local.bat to refresh the analysis.
setlocal
cd /d "%~dp0"
title Release Radar - portal

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if exist dist\index.html goto serve
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm ci
  if errorlevel 1 (
    echo npm ci failed. Check your internet connection or proxy settings.
    pause
    exit /b 1
  )
)
echo Building the portal...
call npm run build > build.log 2>&1
if errorlevel 1 (
  echo The portal could not be built. Details from build.log:
  type build.log
  pause
  exit /b 1
)

:serve
node pipeline/serve.mjs
echo.
echo The portal has stopped.
pause
