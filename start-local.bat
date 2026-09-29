@echo off
REM Release Radar v1.2 - run locally on Windows.
REM   1) analyses UiPath release notes with the agent (first run: every month; later: only new updates)
REM   2) then opens the portal at http://127.0.0.1:5173 with the finished analysis.
REM Needs Node.js 22.12+ (https://nodejs.org). Settings are in .env (stays on this PC).
REM If .env has no token, you are asked for it; it is used for this run only and never saved.
setlocal
cd /d "%~dp0"
title Release Radar - local

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo Node.js 22.12 or newer is required. Found:
  node -v
  pause
  exit /b 1
)

if not exist .env (
  copy /y .env.example .env >nul
  echo Created .env. Fill in UIPATH_TRIGGER_URL, save the file, then run start-local.bat again.
  start "" notepad .env
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm ci
  if errorlevel 1 (
    echo npm ci failed. Check your internet connection or proxy settings.
    pause
    exit /b 1
  )
)

node --env-file=.env pipeline/has-credentials.mjs
if not errorlevel 1 goto have_token
echo.
echo No UiPath token in .env. Paste your Personal Access Token and press Enter.
echo It is hidden while you type, used for this run only, and not saved anywhere.
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "$s = Read-Host 'Token' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "UIPATH_PAT=%%t"
:have_token

node --env-file=.env pipeline/check-env.mjs
if errorlevel 1 (
  start "" notepad .env
  pause
  exit /b 1
)

echo.
echo Step 1 of 2: analysing UiPath release notes with the agent.
echo   First run analyses every month (about 10-20 minutes). Later runs only analyse new UiPath updates.
echo.
set RR_FAIL_ON_PARTIAL=true
node --env-file=.env pipeline/run.js
set RESULT=%errorlevel%
set UIPATH_PAT=
if "%RESULT%"=="1" (
  echo.
  echo The analysis stopped with an error ^(see the message above^). The portal was not started.
  pause
  exit /b 1
)
if "%RESULT%"=="3" (
  echo.
  echo Note: some months could not be fully analysed yet. They are not shown and will be retried on the next run.
)

echo.
echo Step 2 of 2: starting the portal.
call npm run build > build.log 2>&1
if errorlevel 1 goto build_failed
goto serve

:build_failed
if exist dist\index.html (
  echo   Note: the portal could not be rebuilt ^(details in build.log^). Using the existing build.
  goto serve
)
echo   The portal could not be built. Details from build.log:
type build.log
pause
exit /b 1

:serve
node pipeline/serve.mjs
echo.
echo The portal has stopped.
pause
