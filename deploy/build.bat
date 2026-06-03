@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%build-and-push.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] PowerShell build script not found:
    echo         %PS_SCRIPT%
    exit /b 1
)

echo.
echo WQN build and deploy entry:
echo   deploy\build.bat
echo   deploy\build.bat -Tag v1.2.3
echo.
echo Default target:
echo   Build, push, then deploy to Aliyun ECS
echo.

set "HAS_DEPLOY_ALIYUN="
for %%A in (%*) do (
    if /I "%%~A"=="-DeployAliyun" set "HAS_DEPLOY_ALIYUN=1"
)

if defined HAS_DEPLOY_ALIYUN (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %* -DeployAliyun
)
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [DONE] Build script completed successfully.
) else (
    echo [ERROR] Build script failed with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
