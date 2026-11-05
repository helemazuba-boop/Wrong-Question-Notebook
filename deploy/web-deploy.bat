@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ============================================================
::  WQN web release: pick a worktree, build, push, deploy to ECS
:: ============================================================
:: Everything that matters runs in WSL, where docker buildx lives; this
:: file only drives the menu and the hand-off. It mirrors
:: firmware/wqn-zectrix-note4/deploy.bat.
::
::   deploy/web-deploy.bat                    menu
::   deploy/web-deploy.bat D:/path/to/tree    explicit tree
::   set WQN_WEB_DIR=/home/x/WQN              explicit tree (WSL path)
::   set PLAN_ONLY=1                          print the plan, change nothing
::   set WQN_SKIP_REALTIME=1                  app only
::   set WQN_NO_MENU=1                        use the main checkout
::
:: The build reads web/.env.production, which is gitignored and so exists
:: in one tree only; it is copied into the picked tree when missing.
:: ============================================================

set "WSL_DISTRO=Ubuntu"
set "RELEASE_SCRIPT=deploy/release.sh"
set "OUT=%TEMP%\wqn-web-out.txt"

:: This script in WSL terms; the helper sits next to it.
set "SELF_WSL=%~dp0"
set "SELF_WSL=!SELF_WSL:\\wsl.localhost\%WSL_DISTRO%=!"
set "SELF_WSL=!SELF_WSL:\=/!"
if "!SELF_WSL:~-1!"=="/" set "SELF_WSL=!SELF_WSL:~0,-1!"
set "HELPER=!SELF_WSL!/list_worktrees.py"

:: Repository root, so the default tree is the main checkout even if this
:: file is run from a copy. Empty stdin stops wsl.exe eating the console.
wsl -d %WSL_DISTRO% -- python3 "!HELPER!" --repo-root > "!OUT!" 2>&1 < nul
if errorlevel 1 (
  echo ERROR: cannot resolve the repository root:
  type "!OUT!"
  goto :fail
)
set "REPO_WSL="
for /f "usebackq delims=" %%R in ("!OUT!") do set "REPO_WSL=%%R"
if not defined REPO_WSL (
  echo ERROR: the helper printed no repository root.
  goto :fail
)

:: ---------- which tree? ----------
:: Priority: the first argument, then WQN_WEB_DIR, then the menu, then the
:: main checkout. The menu is skipped when stdin is redirected: timeout fails
:: on redirected input, the only reliable console test available in batch.
if not "%~1"=="" (
  set "WEB_DIR=%~1"
  goto :resolve
)
if defined WQN_WEB_DIR (
  set "WEB_DIR=!WQN_WEB_DIR!"
  goto :resolve
)
if /I "!WQN_NO_MENU!"=="1" goto :use_self
timeout /t 0 >nul 2>&1
if errorlevel 1 goto :use_self
call :pick
if errorlevel 1 goto :fail

:resolve
call :normalize "!WEB_DIR!"
if errorlevel 1 goto :fail
goto :banner

:use_self
set "WEB_DIR=!REPO_WSL!"
call :normalize "!WEB_DIR!"
if errorlevel 1 goto :fail

:banner
echo.
echo ========================================
echo  WQN Web Release
echo  Tree:  !WEB_DIR!
echo ========================================
echo.
wsl -d %WSL_DISTRO% -- python3 "!HELPER!" --plan "!WEB_DIR!"
if errorlevel 1 goto :fail

if /I "!PLAN_ONLY!"=="1" (
  echo.
  echo PLAN_ONLY=1: nothing was built, pushed or deployed.
  endlocal
  exit /b 0
)

echo.
echo [1/2] Ensuring build environment file...
set "ENV_SRC="
wsl -d %WSL_DISTRO% -- python3 "!HELPER!" --env-source > "!OUT!" 2>&1 < nul
if errorlevel 1 (
  echo ERROR: no tree has web/.env.production; cannot build.
  goto :fail
)
for /f "usebackq delims=" %%E in ("!OUT!") do set "ENV_SRC=%%E"
if not defined ENV_SRC (
  echo ERROR: no tree has web/.env.production; cannot build.
  goto :fail
)
wsl -d %WSL_DISTRO% -- bash -c "test -f '!WEB_DIR!/web/.env.production' || { cp '!ENV_SRC!' '!WEB_DIR!/web/.env.production' && chmod 600 '!WEB_DIR!/web/.env.production'; }"
if errorlevel 1 goto :fail

echo [2/2] Building, pushing and deploying...
set "REL_ARGS="
if /I "!WQN_SKIP_REALTIME!"=="1" set "REL_ARGS=--skip-realtime"
wsl -d %WSL_DISTRO% -- bash -c "cd '!WEB_DIR!' && WQN_LEGACY_RELEASE=1 WQN_OPS_MANAGED=1 bash !RELEASE_SCRIPT! !REL_ARGS!"
if errorlevel 1 goto :fail

echo.
echo Web release complete.
call :pause_if_interactive
endlocal
exit /b 0

:fail
echo.
echo Web release aborted.
call :pause_if_interactive
endlocal
exit /b 1

:: ---------- subroutines ----------

:pause_if_interactive
if not defined WQN_CHILD pause
exit /b 0

:normalize
set "WEB_DIR=%~1"
set "WEB_DIR=!WEB_DIR:\\wsl.localhost\%WSL_DISTRO%=!"
set "WEB_DIR=!WEB_DIR:\=/!"
if "!WEB_DIR:~-1!"=="/" set "WEB_DIR=!WEB_DIR:~0,-1!"
if not "!WEB_DIR:~0,1!"=="/" set "WEB_DIR=/!WEB_DIR!"
wsl -d %WSL_DISTRO% -- bash -c "test -f '!WEB_DIR!/web/package.json'"
if errorlevel 1 (
  echo ERROR: not a WQN web tree: !WEB_DIR!
  exit /b 1
)
exit /b 0

:pick
echo.
echo Scanning git worktrees...
wsl -d %WSL_DISTRO% -- python3 "!HELPER!" > "!OUT!" 2>&1 < nul
if errorlevel 1 (
  echo ERROR: cannot list worktrees:
  type "!OUT!"
  exit /b 1
)
echo.
type "!OUT!"
echo.
set "PICK="
set /p "PICK=Select tree [Enter = 1]: "
if not defined PICK set "PICK=1"
wsl -d %WSL_DISTRO% -- python3 "!HELPER!" --resolve "!PICK!" > "!OUT!" 2>&1 < nul
if errorlevel 1 (
  echo ERROR: bad selection:
  type "!OUT!"
  exit /b 1
)
set "WEB_DIR="
for /f "usebackq delims=" %%P in ("!OUT!") do set "WEB_DIR=%%P"
if not defined WEB_DIR (
  echo ERROR: no tree selected.
  exit /b 1
)
exit /b 0
