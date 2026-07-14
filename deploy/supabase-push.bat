@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_ROOT=%%~fI"
set "WEB_DIR=%PROJECT_ROOT%\web"
set "EXIT_CODE=0"

cd /d "%WEB_DIR%" || goto fail

set "EXTRA_ARGS="
set "DRY_RUN_ONLY="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--include-all" (
  set "EXTRA_ARGS=--include-all"
  shift
  goto parse_args
)
if /I "%~1"=="--dry-run-only" (
  set "DRY_RUN_ONLY=1"
  shift
  goto parse_args
)
echo ERROR: Unknown argument: %~1
goto fail

:args_done

echo WQN Supabase migration deploy
echo Web dir: %WEB_DIR%
echo Extra args: %EXTRA_ARGS%
if defined DRY_RUN_ONLY echo Mode: dry-run only
echo.

where supabase >nul 2>nul
if errorlevel 1 (
  echo ERROR: Supabase CLI was not found in PATH.
  goto fail
)

echo [1/4] Supabase CLI version
supabase --version
if errorlevel 1 goto fail

echo.
echo [2/4] Current migration status
supabase migration list --linked
if errorlevel 1 goto fail

echo.
echo [3/4] Dry run
supabase db push --linked --dry-run %EXTRA_ARGS%
if errorlevel 1 goto fail

if defined DRY_RUN_ONLY (
  echo.
  echo Dry run complete. No migrations were applied.
  goto success
)

echo.
echo [4/4] Applying pending migrations
if defined EXTRA_ARGS (
  echo WARNING: Running with %EXTRA_ARGS%.
)
supabase db push --linked %EXTRA_ARGS%
if errorlevel 1 goto fail

echo.
echo [verify] Migration status after push
supabase migration list --linked
if errorlevel 1 goto fail

echo.
echo Supabase migration deploy complete.

:success
set "EXIT_CODE=0"
goto done

:fail
set "EXIT_CODE=1"
echo.
echo ERROR: Supabase migration deploy failed.
goto done

:done
echo.
pause
exit /b %EXIT_CODE%
