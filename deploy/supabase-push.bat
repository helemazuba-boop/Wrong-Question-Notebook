@echo off
setlocal

rem Production database pushes are implemented once in the reviewed WSL/bash
rem entrypoint. This preserves the existing flags while preventing the old
rem Windows path from falling back to a linked Supabase Cloud project.
where wsl.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: WSL is required. Run deploy\supabase-push.sh from Ubuntu/WSL. 1>&2
  exit /b 1
)

for /f "usebackq delims=" %%I in (`wsl.exe wslpath -a "%~dp0supabase-push.sh"`) do set "WQN_PUSH_SCRIPT=%%I"
if not defined WQN_PUSH_SCRIPT (
  echo ERROR: Could not resolve deploy\supabase-push.sh in WSL. 1>&2
  exit /b 1
)

wsl.exe bash "%WQN_PUSH_SCRIPT%" %*
exit /b %errorlevel%
