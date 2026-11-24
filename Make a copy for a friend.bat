@echo off
setlocal
title TabMaker - make a copy for a friend
cd /d "%~dp0"
set "OUT=%USERPROFILE%\Desktop\TabMaker.zip"
echo Making a clean copy of TabMaker (without your downloaded songs)...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$tmp = Join-Path $env:TEMP ('TabMaker-share-' + [guid]::NewGuid());" ^
  "$dst = Join-Path $tmp 'TabMaker'; New-Item -ItemType Directory $dst | Out-Null;" ^
  "Copy-Item 'Start TabMaker.bat','How to use.txt','Make a copy for a friend.bat' $dst;" ^
  "robocopy 'app' (Join-Path $dst 'app') /E /XD node_modules data _bench /XF *.map /NFL /NDL /NJH /NJS /NP | Out-Null;" ^
  "Compress-Archive -Path $dst -DestinationPath '%OUT%' -Force;" ^
  "Remove-Item $tmp -Recurse -Force"

if exist "%OUT%" (
  echo.
  echo Done! TabMaker.zip is on your Desktop. Send it to your friend.
  echo They unzip it and double-click "Start TabMaker".
) else (
  echo Something went wrong - the zip was not made.
)
pause
