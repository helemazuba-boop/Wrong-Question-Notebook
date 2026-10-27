@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ops.ps1" release --engine powershell %*
exit /b %ERRORLEVEL%
