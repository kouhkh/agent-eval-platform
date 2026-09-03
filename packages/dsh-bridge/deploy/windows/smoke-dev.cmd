@echo off
setlocal
set "PORT=%~1"
if not defined PORT set "PORT=4319"
curl.exe --fail --silent --show-error "http://127.0.0.1:%PORT%/api/health"
