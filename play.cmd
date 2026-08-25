@echo off
rem ---------------------------------------------------------------------------
rem  Chance of Precipitation - start the game without npm, without an installer, without admin.
rem
rem  The project has no runtime dependencies: "npm start" only ever ran
rem  "node tools/serve.js", so this does that directly. If npm is blocked by
rem  PowerShell's execution policy, or was never installed, nothing here cares.
rem
rem  Double-click this file, or run it from a terminal. Optional arguments are
rem  passed straight through, e.g.  play.cmd --port 9000
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "NODE="

rem 1. Node on PATH is the normal case.
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"

rem 2. Otherwise look where Node installs itself, including the per-user and
rem    portable locations that do not need administrator rights.
if not defined NODE call :probe "%ProgramFiles%\nodejs\node.exe"
if not defined NODE call :probe "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE call :probe "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE call :probe "%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE call :probe "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE call :probe "%USERPROFILE%\node\node.exe"
if not defined NODE call :probe "%~dp0node\node.exe"

if not defined NODE (
  echo.
  echo   Could not find Node.js on this machine.
  echo.
  echo   You do not need administrator rights to get it. Download the Windows
  echo   *binary zip* ^(node-vXX-win-x64.zip^) from https://nodejs.org/en/download,
  echo   unzip it into a folder you own, and either add that folder to your PATH
  echo   or copy node.exe into a "node" folder next to this script.
  echo.
  pause
  exit /b 1
)

echo   Using Node: %NODE%
"%NODE%" tools/serve.js --open %*
echo.
echo   Server stopped.
pause
exit /b 0

:probe
if exist %1 set "NODE=%~1"
goto :eof
