@echo off
setlocal

set "DSH_ROOT=%~1"
set "DSH_AGENT_WORKSPACE_ROOTS=%~2"
set "PORT=%~3"
if not defined PORT set "PORT=4319"

if not defined DSH_ROOT (
  echo Usage: start-dev.cmd DSH_ROOT WORKSPACE_ROOTS [PORT] 1>&2
  exit /b 2
)
if not defined DSH_AGENT_WORKSPACE_ROOTS (
  echo WORKSPACE_ROOTS is required. Separate multiple roots with a semicolon. 1>&2
  exit /b 3
)
if not exist "%DSH_ROOT%\apps\cli\lib\bin.js" (
  echo DSH CLI is not built: %DSH_ROOT% 1>&2
  exit /b 4
)
if not defined DEEPSEEK_API_KEY if not exist "%DSH_ROOT%\.env" (
  echo DEEPSEEK_API_KEY is not configured in the environment or DSH root .env. 1>&2
  exit /b 5
)

cd /d "%~dp0..\.."
node server.mjs
