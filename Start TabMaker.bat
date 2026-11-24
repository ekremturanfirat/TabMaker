@echo off
setlocal
title TabMaker
cd /d "%~dp0app"

rem ===== One-time setup: Python =====
python --version >nul 2>&1
if errorlevel 1 (
  echo Setting up TabMaker for the first time - installing Python...
  winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  echo.
  echo Python is installed. Close this window and double-click "Start TabMaker" again.
  pause
  exit /b
)

rem ===== One-time setup: song links need Deno or Node =====
set HASJS=0
deno --version >nul 2>&1 && set HASJS=1
node --version >nul 2>&1 && set HASJS=1
if "%HASJS%"=="0" (
  echo Setting up TabMaker for the first time - installing Deno for song links...
  winget install -e --id DenoLand.Deno --accept-package-agreements --accept-source-agreements
  echo.
  echo Deno is installed. Close this window and double-click "Start TabMaker" again.
  pause
  exit /b
)

rem ===== Keep the link downloader up to date =====
echo Checking for updates...
python -m pip install --user --upgrade --quiet --disable-pip-version-check yt-dlp >nul 2>&1

rem ===== Start, then open the TabMaker page =====
python server.py --open
if errorlevel 1 (
  echo.
  echo Something went wrong. Send a photo of this window to Ekrem.
  pause
)
