@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_ROOT=%%~fI"
set "WEB_DIR=%PROJECT_ROOT%\web"
set "PS_SCRIPT=%SCRIPT_DIR%build-and-push.ps1"
set "ENV_FILE=%WEB_DIR%\.env.production"
set "EXIT_CODE=0"

if not exist "%PS_SCRIPT%" (
  echo ERROR: PowerShell release script not found:
  echo   %PS_SCRIPT%
  goto fail
)

if not exist "%ENV_FILE%" (
  echo ERROR: Missing production env file:
  echo   %ENV_FILE%
  echo Copy web\.env.production.template to web\.env.production and fill it in.
  goto fail
)

set "NO_DEPLOY="
set "TAG="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--no-deploy" (
  set "NO_DEPLOY=1"
  shift
  goto parse_args
)
if /I "%~1"=="-NoDeploy" (
  set "NO_DEPLOY=1"
  shift
  goto parse_args
)
if "%TAG%"=="" (
  set "TAG=%~1"
  shift
  goto parse_args
)
echo ERROR: Unknown argument: %~1
goto fail

:args_done
if "%TAG%"=="" (
  for /f %%G in ('git -C "%PROJECT_ROOT%" rev-parse --short HEAD 2^>nul') do set "GIT_SHA=%%G"
  if "!GIT_SHA!"=="" set "GIT_SHA=nogit"
  for /f %%D in ('powershell.exe -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%D"
  set "TAG=!STAMP!-!GIT_SHA!"
)

echo WQN Web release
echo Project: %PROJECT_ROOT%
echo Web dir: %WEB_DIR%
echo Tag: %TAG%
if defined NO_DEPLOY (
  echo Deploy: disabled
) else (
  echo Deploy: Aliyun ECS
)
echo.

call :check_required_env
if errorlevel 1 goto fail

echo [release] Starting build and push...
if defined NO_DEPLOY (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Tag "%TAG%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Tag "%TAG%" -DeployAliyun
)
if errorlevel 1 goto fail

echo.
echo Web release complete.
set "EXIT_CODE=0"
goto done

:check_required_env
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = '%ENV_FILE%';" ^
  "$required = @('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','DASHSCOPE_API_KEY','WQN_ESP32_AI_PUBLIC_BASE_URL','WQN_ESP32_AI_AUDIO_URL_SECRET');" ^
  "$placeholders = @('your_anon_key_here','your_service_role_key_here','your_dashscope_api_key_here','replace_with_32_byte_base64_key','replace_with_long_random_secret','https://your-project-id.supabase.co','https://your-domain.com');" ^
  "$vars = @{};" ^
  "Get-Content -LiteralPath $path | ForEach-Object { $line = $_.Trim(); if ($line -and -not $line.StartsWith('#') -and $line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { $value = $Matches[2].Trim(); if (($value.StartsWith('\"') -and $value.EndsWith('\"')) -or ($value.StartsWith(\"'\") -and $value.EndsWith(\"'\"))) { $value = $value.Substring(1, $value.Length - 2) }; $vars[$Matches[1]] = $value } };" ^
  "$bad = @(); foreach ($key in $required) { if (-not $vars.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($vars[$key]) -or $placeholders -contains $vars[$key]) { $bad += $key } };" ^
  "if ($bad.Count -gt 0) { Write-Host 'ERROR: Required env values are missing or still placeholders:' -ForegroundColor Red; $bad | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Yellow }; exit 1 }"
exit /b %ERRORLEVEL%

:fail
set "EXIT_CODE=1"
echo.
echo ERROR: Web release failed.
goto done

:done
echo.
pause
exit /b %EXIT_CODE%
