@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_ROOT=%%~fI"
set "WEB_DIR=%PROJECT_ROOT%\web"
set "PS_APP_SCRIPT=%SCRIPT_DIR%build-and-push.ps1"
set "PS_REALTIME_SCRIPT=%SCRIPT_DIR%build-and-push-realtime.ps1"
set "ENV_FILE=%WEB_DIR%\.env.production"
set "EXIT_CODE=0"

if not exist "%PS_APP_SCRIPT%" (
  echo ERROR: PowerShell app release script not found:
  echo   %PS_APP_SCRIPT%
  goto fail
)

if not exist "%PS_REALTIME_SCRIPT%" (
  echo ERROR: PowerShell realtime release script not found:
  echo   %PS_REALTIME_SCRIPT%
  goto fail
)

if not exist "%ENV_FILE%" (
  echo ERROR: Missing production env file:
  echo   %ENV_FILE%
  echo Copy web\.env.production.template to web\.env.production and fill it in.
  goto fail
)

set "NO_DEPLOY="
set "SKIP_REALTIME="
set "APP_TAG="
set "RT_TAG="

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
if /I "%~1"=="--skip-realtime" (
  set "SKIP_REALTIME=1"
  shift
  goto parse_args
)
if /I "%~1"=="-SkipRealtime" (
  set "SKIP_REALTIME=1"
  shift
  goto parse_args
)
if /I "%~1"=="--rt-tag" (
  shift
  if "%~1"=="" (
    echo ERROR: --rt-tag requires a value.
    goto fail
  )
  set "RT_TAG=%~1"
  shift
  goto parse_args
)
if "%APP_TAG%"=="" (
  set "APP_TAG=%~1"
  shift
  goto parse_args
)
echo ERROR: Unknown argument: %~1
goto fail

:args_done
if "%APP_TAG%"=="" (
  for /f %%G in ('git -C "%PROJECT_ROOT%" rev-parse --short HEAD 2^>nul') do set "GIT_SHA=%%G"
  if "!GIT_SHA!"=="" set "GIT_SHA=nogit"
  for /f %%D in ('powershell.exe -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%D"
  set "APP_TAG=!STAMP!-!GIT_SHA!"
)

if "%RT_TAG%"=="" set "RT_TAG=%APP_TAG%-rt"

echo WQN Web release
echo Project: %PROJECT_ROOT%
echo Web dir: %WEB_DIR%
echo App tag:     %APP_TAG%
echo Realtime tag:%RT_TAG%
if defined NO_DEPLOY (
  echo Deploy: disabled
) else (
  echo Deploy: Aliyun ECS
)
if defined SKIP_REALTIME (
  echo Realtime: skipped
) else (
  echo Realtime: wqn-realtime included
)
echo.

call :check_required_env
if errorlevel 1 goto fail

echo [release] Starting app build and push...
if defined NO_DEPLOY (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_APP_SCRIPT%" -Tag "%APP_TAG%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_APP_SCRIPT%" -Tag "%APP_TAG%" -DeployAliyun
)
if errorlevel 1 goto fail

if not defined SKIP_REALTIME (
  echo.
  echo [release] Starting wqn-realtime build and push ^(tag %RT_TAG%^)...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_REALTIME_SCRIPT%" -Tag "%RT_TAG%"
  if errorlevel 1 goto fail

  if not defined NO_DEPLOY (
    echo.
    echo [release] Deploying wqn-realtime to Aliyun ECS...
    call :deploy_realtime "%RT_TAG%"
    if errorlevel 1 goto fail
  )
)

echo.
echo Web release complete.
echo.
echo Reminders:
echo   1. Add these to nginx on ECS:
echo        location = /api/esp32/realtime {
echo            proxy_pass http://127.0.0.1:8080/api/esp32/realtime;
echo            proxy_http_version 1.1;
echo            proxy_set_header Upgrade $http_upgrade;
echo            proxy_set_header Connection "upgrade";
echo            proxy_set_header Host $host;
echo            proxy_read_timeout 1h;
echo            proxy_send_timeout 1h;
echo            proxy_buffering off;
echo        }
echo   2. Run 'sudo nginx -t ^&^& sudo nginx -s reload' on ECS.
echo   3. Verify: curl -i --upgrade https://wqn.helema.cn/api/esp32/realtime
set "EXIT_CODE=0"
goto done

:check_required_env
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = '%ENV_FILE%';" ^
  "$required = @('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','DASHSCOPE_API_KEY','WQN_ESP32_AI_PUBLIC_BASE_URL','WQN_ESP32_AI_AUDIO_URL_SECRET','STEP_API_KEY','WQN_REALTIME_PROXY_SECRET','WQN_INTERNAL_API_BASE');" ^
  "$placeholders = @('your_anon_key_here','your_service_role_key_here','your_dashscope_api_key_here','replace_with_32_byte_base64_key','replace_with_long_random_secret','https://your-project-id.supabase.co','https://your-domain.com','replace_with_stepfun_api_key');" ^
  "$vars = @{};" ^
  "Get-Content -LiteralPath $path | ForEach-Object { $line = $_.Trim(); if ($line -and -not $line.StartsWith('#') -and $line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { $value = $Matches[2].Trim(); if (($value.StartsWith('\"') -and $value.EndsWith('\"')) -or ($value.StartsWith(\"'\") -and $value.EndsWith(\"'\"))) { $value = $value.Substring(1, $value.Length - 2) }; $vars[$Matches[1]] = $value } };" ^
  "$bad = @(); foreach ($key in $required) { if (-not $vars.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($vars[$key]) -or $placeholders -contains $vars[$key]) { $bad += $key } };" ^
  "if ($bad.Count -gt 0) { Write-Host 'ERROR: Required env values are missing or still placeholders:' -ForegroundColor Red; $bad | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Yellow }; exit 1 }"
exit /b %ERRORLEVEL%

:deploy_realtime
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%deploy-realtime-remote.ps1" -Tag "%~1"
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