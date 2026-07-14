# ============================================================
# WQN Realtime Remote Deploy Script (Windows PowerShell)
# ============================================================
# Companion to web-release.bat. Pulls the wqn-realtime image from
# ACR on the Aliyun ECS host and (re)starts the wqn-realtime
# container.
#
# IMPORTANT:
#   * We publish the realtime port on 127.0.0.1 only — nginx on
#     the host is the only thing that should reach it.
#   * The wqn-app container already loads `~/.env.production` on
#     the host. wqn-realtime reuses the SAME file so there's
#     exactly one source of truth on the box.
#   * We ALWAYS upload the full local web/.env.production to the
#     host on every deploy (overwriting). The host file is a derived
#     artifact; web/.env.production is the single source of truth, so
#     never edit the host copy directly - edit local and redeploy.
#
# USAGE (called from web-release.bat, not normally invoked directly):
#   .\deploy\deploy-realtime-remote.ps1 -Tag "v1.2.3"
# ============================================================

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$Tag = "latest",

    [string]$AliyunSshHost = "aliyun",

    [string]$RealtimeContainerName = "wqn-realtime",

    # Bind only on loopback. nginx on the host reaches wqn-realtime
    # at 127.0.0.1:8080. Do NOT use 0.0.0.0.
    [string]$RealtimePortMap = "127.0.0.1:8080:8080",

    [string]$AliyunEnvFile = ".env.production",

    [string]$RealtimeRepo = "wqn-realtime"
)

$ErrorActionPreference = "Stop"

# ---------- Validate inputs ----------
$sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $sshCommand) {
    Write-Host ""
    Write-Host "  [ERROR] OpenSSH client is not available on this machine." -ForegroundColor Red
    exit 1
}

$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$WebDir = Join-Path $ProjectRoot "web"
$EnvFile = Join-Path $WebDir ".env.production"

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host "  [ERROR] .env.production not found at $EnvFile" -ForegroundColor Red
    exit 1
}

# Read ACR coordinates from the same env file used by build-and-push.ps1
$envVars = @{}
foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $envVars[$Matches[1]] = $value
    }
}

$requiredKeys = @("ACR_SERVER", "ACR_NAMESPACE", "ACR_USERNAME", "ACR_PASSWORD")
foreach ($k in $requiredKeys) {
    if ([string]::IsNullOrWhiteSpace($envVars[$k])) {
        Write-Host "  [ERROR] $k missing from .env.production" -ForegroundColor Red
        exit 1
    }
}

$acrServer = $envVars["ACR_SERVER"]
$acrNamespace = $envVars["ACR_NAMESPACE"]
$image = "${acrServer}/${acrNamespace}/${RealtimeRepo}:${Tag}"

$remoteEnvFile = if ([System.IO.Path]::IsPathRooted($AliyunEnvFile)) {
    $AliyunEnvFile
} else {
    "`$HOME/$AliyunEnvFile"
}
$realtimeRemoteEnvFile = "`$HOME/$AliyunEnvFile"

$requiredRuntimeKeys = @(
    "STEP_API_KEY",
    "WQN_REALTIME_PROXY_SECRET",
    "WQN_INTERNAL_API_BASE",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
)

# ----------------------------------------------------------------
# All bash scripts below are uploaded via scp and invoked through
# `ssh ... bash <path>`. We never pipe bash via PS stdin —
# PowerShell 5.x rewrites LF to CRLF during the encode step and
# bash then chokes on bare \r. scp is byte-clean.
# ----------------------------------------------------------------
function Invoke-RemoteBash {
    param(
        [Parameter(Mandatory)] [string]$LocalScriptPath
    )
    $remotePath = "/tmp/wqn-rt-$([guid]::NewGuid().ToString('N').Substring(0,12)).sh"

    # Upload. Relax ErrorActionPreference so scp/ssh writing to stderr
    # (e.g. "WARNING! Your password will be stored unencrypted" from
    # docker login) doesn't trigger a terminating error under "Stop".
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    $scpOut = scp $LocalScriptPath "${AliyunSshHost}:${remotePath}" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $ErrorActionPreference = $prevEAP
        return @{
            ExitCode = -1
            Output   = ("scp upload failed: " + ($scpOut -join "`n"))
        }
    }
    # Run via ssh. The remote command runs the script, captures its
    # exit code, removes the file, then exits with that same code.
    $remoteCmd = "bash '$remotePath' ; ec=`$? ; rm -f '$remotePath' ; exit `$ec"
    $output = ssh $AliyunSshHost $remoteCmd 2>&1
    $ec = $LASTEXITCODE

    $ErrorActionPreference = $prevEAP
    return @{
        ExitCode = $ec
        Output   = ($output -join "`n")
    }
}

$tmpDir = [System.IO.Path]::GetTempPath()
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# ------------------ Step 1: ensure env file on host ----------
Write-Host ""
Write-Host "  [1/4] Checking host env file: $realtimeRemoteEnvFile ..." -ForegroundColor Yellow

# Probe: ask bash whether the path actually resolves to a readable
# file. We expand $HOME explicitly via the login shell (`bash -l`)
# because some non-interactive ssh invocations don't source profile
# files and end up with HOME unset. We also print the resolved path
# so any mismatch is visible in the log.
$probeScriptPath = Join-Path $tmpDir "wqn-probe-env.sh"
$probeLines = @(
    '#!/bin/bash'
    'set +e'
    'echo "[probe] user=$(whoami)"'
    # Some SSH client setups (notably Windows OpenSSH) inject the
    # local $HOME into the remote session, so we cannot rely on the
    # inherited $HOME. Instead, derive the path from getent /
    # /etc/passwd so it always points to the actual login home of
    # the current user on the host.
    'HOME_DIR=$(getent passwd "$(whoami)" | cut -d: -f6)'
    'if [ -z "$HOME_DIR" ]; then HOME_DIR=$(awk -F: -v u="$(whoami)" ''$1==u {print $6}'' /etc/passwd); fi'
    'echo "[probe] resolved_home=$HOME_DIR"'
    'ENV_FILE="$HOME_DIR/.env.production"'
    'echo "[probe] resolved_path=$ENV_FILE"'
    'if [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then'
    '    echo EXISTS'
    'else'
    '    echo MISSING'
    'fi'
)
[System.IO.File]::WriteAllText($probeScriptPath, ($probeLines -join "`n") + "`n", $utf8NoBom)

$probeResult = Invoke-RemoteBash -LocalScriptPath $probeScriptPath
Remove-Item -LiteralPath $probeScriptPath -Force -ErrorAction SilentlyContinue
$probeText = $probeResult.Output

# Surface the probe detail lines to the user (user / path / EXISTS|MISSING).
foreach ($line in ($probeText -split "`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[probe\]|^(EXISTS|MISSING)$') {
        Write-Host "        $trimmed" -ForegroundColor DarkGray
    }
}

$envExists = (($probeText -split "`n") | Where-Object { $_ -match '^(EXISTS|MISSING)$' } | Select-Object -Last 1)
if (-not $envExists) {
    $envExists = "UNKNOWN (probe output: $($probeText.Trim()))"
}
Write-Host "        $envExists" -ForegroundColor DarkGray

# Always upload the local env file so the host never drifts from
# web/.env.production after local edits. The probe above is kept only
# to surface the resolved path / prior state in the log.
Write-Host "        Uploading from local $EnvFile (overwriting host)..." -ForegroundColor Yellow
$content = Get-Content -LiteralPath $EnvFile -Raw
$content = ($content -replace "`r`n", "`n") -replace "`r", "`n"
if (-not $content.EndsWith("`n")) { $content += "`n" }
$base64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($content)
)

$uploadScriptPath = Join-Path $tmpDir "wqn-upload-env.sh"
$uplLines = @(
    '#!/bin/bash'
    'set -e'
    # Derive the user's real home from /etc/passwd so a wrong
    # $HOME injected by the SSH client (Windows OpenSSH does this)
    # cannot send the file to a path the user can never use.
    'HOME_DIR=$(getent passwd "$(whoami)" | cut -d: -f6)'
    'if [ -z "$HOME_DIR" ]; then HOME_DIR=$(awk -F: -v u="$(whoami)" ''$1==u {print $6}'' /etc/passwd); fi'
    'ENV_FILE="$HOME_DIR/.env.production"'
    'mkdir -p "$(dirname "$ENV_FILE")"'
    'umask 077'
    'printf ''%s'' ''' + $base64 + ''' | base64 -d > "$ENV_FILE"'
    'chmod 600 "$ENV_FILE"'
    'echo "uploaded; size=$(wc -c < "$ENV_FILE")"'
)
[System.IO.File]::WriteAllText($uploadScriptPath, ($uplLines -join "`n") + "`n", $utf8NoBom)

$uploadResult = Invoke-RemoteBash -LocalScriptPath $uploadScriptPath
Remove-Item -LiteralPath $uploadScriptPath -Force -ErrorAction SilentlyContinue
# Always show what happened on the host, even when it succeeded.
Write-Host "        Upload result: ec=$($uploadResult.ExitCode)" -ForegroundColor DarkGray
if ($uploadResult.Output) {
    foreach ($line in ($uploadResult.Output -split "`n")) {
        $trim = $line.Trim()
        if ($trim) { Write-Host "          $trim" -ForegroundColor DarkGray }
    }
}
if ($uploadResult.ExitCode -ne 0) {
    Write-Host "  [ERROR] Failed to upload env file to host." -ForegroundColor Red
    Write-Host "          $($uploadResult.Output)" -ForegroundColor Yellow
    exit 1
}

# ------------------ Step 2: validate env keys on host --------
$placeholderSubstrings = @(
    "replace_with_stepfun_api_key",
    "replace_with_long_random_secret",
    "https://your-project-id.supabase.co",
    "your_anon_key_here",
    "your_service_role_key_here"
)

$envPathEscaped = $realtimeRemoteEnvFile -replace "'", "'\''"
# Build space-separated, escaped lists. The PS single-quoted strings
# already wrap the result, so we just join with spaces here. The
# bash-side `"KEYS='$keysQ'"` then closes the quote around the list
# cleanly without producing nested '' '' that bash would parse as
# empty-string + unquoted tokens.
$keysQ = ($requiredRuntimeKeys | ForEach-Object { $_ -replace "'", "'\''" }) -join " "
$phsQ  = ($placeholderSubstrings  | ForEach-Object { $_ -replace "'", "'\''" }) -join " "

$checkLines = @(
    '#!/bin/bash'
    'set +e'
    # Same home-resolution trick as the probe script: SSH clients
    # may inject a wrong $HOME into the remote session, so derive
    # it from /etc/passwd instead.
    'HOME_DIR=$(getent passwd "$(whoami)" | cut -d: -f6)'
    'if [ -z "$HOME_DIR" ]; then HOME_DIR=$(awk -F: -v u="$(whoami)" ''$1==u {print $6}'' /etc/passwd); fi'
    'ENV_FILE="$HOME_DIR/.env.production"'
    "KEYS='$keysQ'"
    "PHS='$phsQ'"
    'missing=""'
    'for k in $KEYS; do'
    '    line=$(grep -E "^${k}=" "$ENV_FILE" | head -1)'
    # Strip optional comment after the value (".env.production ships
    # with inline "# 已填" / "# 已有" annotations) and surrounding
    # whitespace, then unwrap surrounding double-quotes if any.
    '    v=$(printf "%s" "$line" | sed -n ''s/^[^=]*=//p'' | cut -d"#" -f1 | sed -e ''s/^[[:space:]]*//'' -e ''s/[[:space:]]*$//'' -e ''s/^"\\(.*\\)"$/\\1/p'')'
    '    if [ -z "$v" ]; then missing="$missing $k(empty)"; continue; fi'
    '    is_ph=0'
    '    for p in $PHS; do if [ "$v" = "$p" ]; then is_ph=1; break; fi; done'
    '    if [ "$is_ph" = "1" ]; then missing="$missing $k(placeholder)"; fi'
    'done'
    'if [ -n "$missing" ]; then echo "MISSING:$missing" >&2; exit 2; fi'
    'echo OK'
)
$checkScriptPath = Join-Path $tmpDir "wqn-check-env.sh"
[System.IO.File]::WriteAllText($checkScriptPath, ($checkLines -join "`n") + "`n", $utf8NoBom)

Write-Host "  [2/4] Validating required env keys on host..." -ForegroundColor Yellow
$checkResult = Invoke-RemoteBash -LocalScriptPath $checkScriptPath
Remove-Item -LiteralPath $checkScriptPath -Force -ErrorAction SilentlyContinue
if ($checkResult.ExitCode -ne 0) {
    Write-Host "  [ERROR] Host env file is missing or has placeholders." -ForegroundColor Red
    Write-Host "          $($checkResult.Output)" -ForegroundColor Yellow
    Write-Host "          Edit the file at $realtimeRemoteEnvFile on the host." -ForegroundColor Yellow
    exit 1
}

# ------------------ Step 3: pull & (re)start container -------
$passwordB64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($envVars["ACR_PASSWORD"])
)
$remoteLines = @(
    '#!/bin/bash'
    'set -e'
    "IMAGE='" + ($image -replace "'", "'\''") + "'"
    "CONTAINER='" + ($RealtimeContainerName -replace "'", "'\''") + "'"
    "PORT_MAP='" + ($RealtimePortMap -replace "'", "'\''") + "'"
    "ENV_FILE_NAME='" + ($AliyunEnvFile -replace "'", "'\''") + "'"
    # [env-path-fix] Resolve $HOME from /etc/passwd (same as steps 1 & 2).
    # The earlier form `ENV_FILE='$HOME/.env.production'` left $HOME
    # single-quoted and unexpanded, so docker got a literal nonexistent
    # path and the container started with NO env vars -> "STEP_API_KEY
    # missing" even though the file was uploaded and validated.
    'HOME_DIR=$(getent passwd "$(whoami)" | cut -d: -f6)'
    'if [ -z "$HOME_DIR" ]; then HOME_DIR=$(awk -F: -v u="$(whoami)" ''$1==u {print $6}'' /etc/passwd); fi'
    'ENV_FILE="$HOME_DIR/$ENV_FILE_NAME"'
    "ACR_USER='" + ($envVars["ACR_USERNAME"] -replace "'", "'\''") + "'"
    "ACR_SERVER='" + ($acrServer -replace "'", "'\''") + "'"
    "PASSWORD_B64='$passwordB64'"
    'echo "[realtime-deploy] logging into ACR..."'
    'echo "$PASSWORD_B64" | base64 -d | docker login "$ACR_SERVER" -u "$ACR_USER" --password-stdin'
    'echo "[realtime-deploy] pulling image..."'
    'docker pull "$IMAGE"'
    'echo "[realtime-deploy] stopping/removing existing container..."'
    'docker stop "$CONTAINER" 2>/dev/null || true'
    'docker rm "$CONTAINER" 2>/dev/null || true'
    'echo "[realtime-deploy] starting new container..."'
    'CONTAINER_ID=$(docker run -d \'
    '    --name "$CONTAINER" \'
    '    --restart unless-stopped \'
    '    --env-file "$ENV_FILE" \'
    '    -p "$PORT_MAP" \'
    '    "$IMAGE")'
    'echo "container_id=$CONTAINER_ID"'
    'echo "[realtime-deploy] waiting for /health..."'
    'for i in 1 2 3 4 5 6 7 8 9 10; do'
    '    if docker exec "$CONTAINER" wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then'
    '        echo "[realtime-deploy] health check ok"'
    '        exit 0'
    '    fi'
    '    sleep 2'
    'done'
    'echo "[realtime-deploy] health check FAILED after 20s, dumping logs:" >&2'
    'docker logs --tail 50 "$CONTAINER" >&2'
    'exit 1'
)
$remoteScriptPath = Join-Path $tmpDir "wqn-remote-deploy.sh"
[System.IO.File]::WriteAllText($remoteScriptPath, ($remoteLines -join "`n") + "`n", $utf8NoBom)

Write-Host "  [3/4] Pulling image and starting container on host..." -ForegroundColor Yellow
$deployResult = Invoke-RemoteBash -LocalScriptPath $remoteScriptPath
Remove-Item -LiteralPath $remoteScriptPath -Force -ErrorAction SilentlyContinue
if ($deployResult.ExitCode -ne 0) {
    Write-Host "  [ERROR] wqn-realtime deploy failed on host." -ForegroundColor Red
    Write-Host "          $($deployResult.Output)" -ForegroundColor Yellow
    exit 1
}

Write-Host "  [4/4] wqn-realtime is up." -ForegroundColor Green
Write-Host ""
Write-Host "  Verify on host:" -ForegroundColor Yellow
Write-Host "    docker ps --filter name=$RealtimeContainerName" -ForegroundColor White
Write-Host "    curl http://127.0.0.1:8080/health" -ForegroundColor White
Write-Host "    curl -i --upgrade https://wqn.helema.cn/api/esp32/realtime" -ForegroundColor White
