@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ops.ps1" serve %*
exit /b %ERRORLEVEL%
