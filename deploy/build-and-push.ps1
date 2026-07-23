# ============================================================
# WQN Build & Push Script (Windows PowerShell)
# ============================================================
# Builds the Docker image for linux/amd64 and pushes it to
# Alibaba Cloud ACR (personal tier).
#
# NOTE: ACR Personal does not support manifest lists. The build
# disables provenance attestations to keep the pushed artifact a
# single-platform image manifest.
#
# PREREQUISITES:
#   - Docker Desktop installed and running
#   - Docker Buildx available
#   - web/.env.production filled with all required values
#
# USAGE:
#   .\deploy\build-and-push.ps1
#   .\deploy\build-and-push.ps1 -Tag "v1.2.3"
#   .\deploy\build-and-push.ps1 -DeployAliyun
# ============================================================

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$Tag = "latest",

    [switch]$RecreateBuilder,

    [switch]$DeployAliyun,

    [string]$AliyunSshHost = "aliyun",

    [string]$AliyunContainerName = "wqn-app",

    [ValidatePattern('^\d+:\d+$')]
    [string]$AliyunPortMap = "3000:3000",

    [string]$AliyunEnvFile = ".env.production",

    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$AliyunNetworkName = "wqn-runtime"
)

$ErrorActionPreference = "Stop"

# ---------- Paths ----------
$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$WebDir = Join-Path $ProjectRoot "web"
$Dockerfile = Join-Path $WebDir "Dockerfile"
$EnvFile = Join-Path $WebDir ".env.production"
$BuildkitConfig = Join-Path $ScriptRoot "buildkit-config.toml"
$BuildkitConfigHashFile = Join-Path $ScriptRoot ".wqn-builder-config.hash"
$BuilderName = "wqn-builder"
$DefaultBuildProxy = "http://127.0.0.1:7890"

# ============================================================
# Helper functions
# ============================================================

function Write-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Msg,

        [System.ConsoleColor]$Color = "Yellow"
    )

    Write-Host "  [$((Get-Date).ToString('HH:mm:ss'))] $Msg" -ForegroundColor $Color
}

function Read-DotEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $vars = @{}
    $lineNumber = 0

    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $lineNumber++
        $line = $rawLine.Trim()

        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            continue
        }

        if ($line.StartsWith("export ")) {
            $line = $line.Substring(7).TrimStart()
        }

        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
            throw "Invalid .env.production line ${lineNumber}: $rawLine"
        }

        $key = $Matches[1]
        $value = $Matches[2].Trim()

        if (
            $value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        } else {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }

        $vars[$key] = $value
    }

    return $vars
}

function Get-EnvValue {
    param([string]$Key)

    if ($script:EnvVars.ContainsKey($Key)) {
        return $script:EnvVars[$Key]
    }

    return $null
}

function Test-RequiredValues {
    param([string[]]$Keys)

    $missing = $Keys | Where-Object {
        [string]::IsNullOrWhiteSpace((Get-EnvValue $_))
    }

    if ($missing) {
        Write-Host ""
        Write-Host "  [ERROR] Missing required fields in .env.production:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        exit 1
    }
}

function New-BuildArgList {
    param(
        [string[]]$AppVarKeys
    )

    $result = @()

    foreach ($key in $AppVarKeys) {
        $value = Get-EnvValue $key
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $result += "--build-arg"
            $result += "${key}=${value}"
        }
    }

    return $result
}

function New-RuntimeEnvFileContent {
    param(
        [string[]]$RuntimeVarKeys
    )

    $lines = @()

    foreach ($key in $RuntimeVarKeys) {
        $value = Get-EnvValue $key
        if ($null -ne $value) {
            if ($value -match "[`r`n]") {
                throw "$key contains a newline and cannot be written to an env file"
            }
            $lines += "${key}=${value}"
        }
    }

    return ($lines -join "`n") + "`n"
}

function Invoke-DockerCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Some Docker/Buildx probes intentionally fail, for example when a
        # builder does not exist yet. With $ErrorActionPreference = Stop,
        # redirected native stderr can become a terminating PowerShell error
        # before we can inspect $LASTEXITCODE.
        $ErrorActionPreference = "Continue"
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $output
    }
}

function Join-ProcessArguments {
    param([string[]]$Arguments)

    $quoted = @()
    foreach ($arg in $Arguments) {
        if ($arg -match '[\s"]') {
            $quoted += '"' + ($arg -replace '"', '\"') + '"'
        } else {
            $quoted += $arg
        }
    }
    return ($quoted -join " ")
}

function Invoke-DockerLogin {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Server,

        [Parameter(Mandatory = $true)]
        [string]$Username,

        [Parameter(Mandatory = $true)]
        [string]$Password,

        [int]$TimeoutSeconds = 60
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "docker"
    $psi.Arguments = Join-ProcessArguments @("login", $Server, "--username", $Username, "--password-stdin")
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    if (-not $process.Start()) {
        Write-Host "  [ERROR] Failed to start docker login." -ForegroundColor Red
        exit 1
    }

    try {
        $process.StandardInput.WriteLine($Password)
        $process.StandardInput.Close()

        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try {
                $process.Kill()
            } catch {
                # Ignore cleanup failure; the timeout error below is actionable.
            }
            Write-Host "  [ERROR] ACR login timed out after ${TimeoutSeconds}s." -ForegroundColor Red
            Write-Host "  Check Docker Desktop, credential helper, ACR network access, or run: docker logout $Server" -ForegroundColor Yellow
            exit 1
        }

        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0) {
            Write-Host "  [ERROR] ACR login failed." -ForegroundColor Red
            if (-not [string]::IsNullOrWhiteSpace($stdout)) {
                Write-Host $stdout.Trim() -ForegroundColor Yellow
            }
            if (-not [string]::IsNullOrWhiteSpace($stderr)) {
                Write-Host $stderr.Trim() -ForegroundColor Yellow
            }
            exit 1
        }

        if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            Write-Host $stdout.Trim()
        }
        if (-not [string]::IsNullOrWhiteSpace($stderr)) {
            Write-Host $stderr.Trim() -ForegroundColor DarkGray
        }
    } finally {
        $process.Dispose()
    }
}

function Convert-ToBuilderProxyUrl {
    param([string]$ProxyUrl)

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return $null
    }

    # The buildx docker-container driver runs inside a container. Its
    # 127.0.0.1 is not the Windows host, so route host-local proxies through
    # Docker Desktop's host.docker.internal name.
    return $ProxyUrl.Trim() `
        -replace '://127\.0\.0\.1:', '://host.docker.internal:' `
        -replace '://localhost:', '://host.docker.internal:'
}

function Get-BuilderConfigHash {
    if (-not (Test-Path -LiteralPath $BuildkitConfig)) {
        $configHash = "none"
    } else {
        $configHash = (Get-FileHash -LiteralPath $BuildkitConfig -Algorithm SHA256).Hash
    }

    $builderProxy = Convert-ToBuilderProxyUrl $script:BuildProxy
    return "$configHash|proxy=$builderProxy|no_proxy=$script:BuildNoProxy"
}

function Get-RecordedBuilderConfigHash {
    if (-not (Test-Path -LiteralPath $BuildkitConfigHashFile)) {
        return $null
    }

    return (Get-Content -LiteralPath $BuildkitConfigHashFile -Raw).Trim()
}

function Set-RecordedBuilderConfigHash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hash
    )

    Set-Content -LiteralPath $BuildkitConfigHashFile -Value $Hash -NoNewline -Encoding ASCII
}

function Test-DockerBuildx {
    $result = Invoke-DockerCapture -Arguments @("buildx", "version")
    if ($result.ExitCode -ne 0) {
        Write-Host ""
        Write-Host "  [ERROR] Docker Buildx is not available." -ForegroundColor Red
        Write-Host "  Please ensure Docker Desktop is installed and running." -ForegroundColor Yellow
        exit 1
    }

    Write-Step "Docker Buildx available: $($result.Output)" "Cyan"
}

function Initialize-Buildx {
    Write-Step "Checking Buildx builder: $BuilderName"

    $expectedConfigHash = Get-BuilderConfigHash
    $recordedConfigHash = Get-RecordedBuilderConfigHash
    $existing = Invoke-DockerCapture -Arguments @("buildx", "inspect", $BuilderName)

    if ($existing.ExitCode -eq 0) {
        $configHashMatches = $recordedConfigHash -eq $expectedConfigHash

        if ($RecreateBuilder -or -not $configHashMatches) {
            if ($RecreateBuilder) {
                Write-Step "Recreating builder because -RecreateBuilder was provided." "Yellow"
            } else {
                Write-Step "Recreating builder because BuildKit config changed." "Yellow"
            }

            $remove = Invoke-DockerCapture -Arguments @("buildx", "rm", "--force", $BuilderName)
            if ($remove.ExitCode -ne 0) {
                Write-Host "  [ERROR] Failed to remove existing builder: $($remove.Output)" -ForegroundColor Red
                exit 1
            }

            $existing = Invoke-DockerCapture -Arguments @("buildx", "inspect", $BuilderName)
        }
    }

    if ($existing.ExitCode -ne 0) {
        Write-Step "Creating docker-container builder: $BuilderName" "Yellow"

        $createArgs = @(
            "buildx", "create",
            "--name", $BuilderName,
            "--driver", "docker-container"
        )
        $builderProxy = Convert-ToBuilderProxyUrl $script:BuildProxy
        if (-not [string]::IsNullOrWhiteSpace($builderProxy)) {
            $createArgs += @(
                "--driver-opt", "env.HTTP_PROXY=$builderProxy",
                "--driver-opt", "env.HTTPS_PROXY=$builderProxy",
                "--driver-opt", "env.http_proxy=$builderProxy",
                "--driver-opt", "env.https_proxy=$builderProxy"
            )
        }
        if (Test-Path -LiteralPath $BuildkitConfig) {
            $createArgs += @("--config", $BuildkitConfig)
        }

        $create = Invoke-DockerCapture -Arguments $createArgs
        if ($create.ExitCode -ne 0) {
            Write-Host "  [ERROR] Failed to create builder: $($create.Output)" -ForegroundColor Red
            exit 1
        }

        Set-RecordedBuilderConfigHash -Hash $expectedConfigHash
    } else {
        Write-Step "Using existing builder." "Cyan"
    }

    $use = Invoke-DockerCapture -Arguments @("buildx", "use", $BuilderName)
    if ($use.ExitCode -ne 0) {
        Write-Host "  [ERROR] Failed to select Buildx builder: $BuilderName" -ForegroundColor Red
        Write-Host "  $($use.Output)" -ForegroundColor Red
        exit 1
    }

    Write-Step "Checking builder status..." "Yellow"
    $inspect = Invoke-DockerCapture -Arguments @("buildx", "inspect", $BuilderName)
    if ($inspect.ExitCode -ne 0) {
        Write-Host "  [ERROR] Cannot inspect builder: $($inspect.Output)" -ForegroundColor Red
        exit 1
    }

    $inspectOutput = $inspect.Output -join [Environment]::NewLine
    if ($inspectOutput -match "Status:\s*running") {
        Write-Step "Builder is running." "Green"
        return
    }

    Write-Step "Bootstrapping builder..." "Yellow"
    $bootstrap = Invoke-DockerCapture -Arguments @("buildx", "inspect", $BuilderName, "--bootstrap")
    if ($bootstrap.ExitCode -ne 0) {
        Write-Host "  [ERROR] Builder bootstrap failed." -ForegroundColor Red
        Write-Host "  $($bootstrap.Output)" -ForegroundColor Red
        exit 1
    }

    Write-Step "Builder ready." "Green"
}

function Invoke-DockerBuild {
    param([string[]]$BuildArgs)

    $dockerArgs = @(
        "buildx", "build",
        "--platform", "linux/amd64",
        "--builder", $BuilderName,
        "--provenance=false",
        "--secret", "id=next_server_actions_encryption_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
        "--push",
        "-t", $ImageTag,
        "-f", $Dockerfile
    )

    $dockerArgs += $BuildArgs
    $dockerArgs += "."

    Push-Location $WebDir
    try {
        $oldHttpProxy = $env:HTTP_PROXY
        $oldHttpsProxy = $env:HTTPS_PROXY
        $oldLowerHttpProxy = $env:http_proxy
        $oldLowerHttpsProxy = $env:https_proxy
        $oldNoProxy = $env:NO_PROXY
        $oldLowerNoProxy = $env:no_proxy
        $oldServerActionsKey = $env:NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

        $env:NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = Get-EnvValue "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"

        if (-not [string]::IsNullOrWhiteSpace($script:BuildProxy)) {
            $env:HTTP_PROXY = $script:BuildProxy
            $env:HTTPS_PROXY = $script:BuildProxy
            $env:http_proxy = $script:BuildProxy
            $env:https_proxy = $script:BuildProxy
        }
        if (-not [string]::IsNullOrWhiteSpace($script:BuildNoProxy)) {
            $env:NO_PROXY = $script:BuildNoProxy
            $env:no_proxy = $script:BuildNoProxy
        }

        & docker @dockerArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] Build failed." -ForegroundColor Red
            Write-Host "  If the error mentions auth.docker.io or node:24-alpine, check WQN_BUILD_PROXY or set BASE_NODE_IMAGE in web/.env.production to a reachable Node image." -ForegroundColor Yellow
            exit 1
        }
    } finally {
        $env:HTTP_PROXY = $oldHttpProxy
        $env:HTTPS_PROXY = $oldHttpsProxy
        $env:http_proxy = $oldLowerHttpProxy
        $env:https_proxy = $oldLowerHttpsProxy
        $env:NO_PROXY = $oldNoProxy
        $env:no_proxy = $oldLowerNoProxy
        $env:NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = $oldServerActionsKey
        Pop-Location
    }
}

function Test-SshClient {
    $sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
    if (-not $sshCommand) {
        Write-Host ""
        Write-Host "  [ERROR] OpenSSH client is not available on this machine." -ForegroundColor Red
        Write-Host "  Install OpenSSH Client or run this from a shell where ssh is available." -ForegroundColor Yellow
        exit 1
    }
}

function Invoke-AliyunDeploy {
    Test-SshClient

    Write-Step "Deploying image to Aliyun host: $AliyunSshHost" "Yellow"

    $remoteEnvFile = if ([System.IO.Path]::IsPathRooted($AliyunEnvFile)) {
        $AliyunEnvFile
    } else {
        "`$HOME/$AliyunEnvFile"
    }

    $runtimeEnvContent = New-RuntimeEnvFileContent -RuntimeVarKeys $script:RuntimeVarKeys
    $runtimeEnvBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($runtimeEnvContent))

    Write-Step "Uploading runtime env file to Aliyun host: $remoteEnvFile" "Yellow"
    $uploadEnvScript = @"
set -e
ENV_FILE='$remoteEnvFile'
mkdir -p "`$(dirname "`$ENV_FILE")"
umask 077
printf '%s' '$runtimeEnvBase64' | base64 -d > "`$ENV_FILE"
printf '%s\n' '[deploy] Runtime env file updated.'
"@

    $uploadEnvScript | & ssh $AliyunSshHost "bash -s"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Failed to upload runtime env file." -ForegroundColor Red
        exit 1
    }

    $remoteScript = @"
set -e

IMAGE='$ImageTag'
CONTAINER='$AliyunContainerName'
PORT_MAP='$AliyunPortMap'
ENV_FILE='$remoteEnvFile'
NETWORK='$AliyunNetworkName'

printf '%s\n' '[deploy] Pulling latest image...'
docker pull "`$IMAGE"

if [ ! -f "`$ENV_FILE" ]; then
  printf '%s\n' "[deploy] Missing env file: `$ENV_FILE" >&2
  printf '%s\n' '[deploy] Copy web/.env.production to the ECS host or pass -AliyunEnvFile.' >&2
  exit 1
fi

printf '%s\n' '[deploy] Stopping and removing old container...'
docker stop "`$CONTAINER" || true
docker rm "`$CONTAINER" || true

printf '%s\n' '[deploy] Ensuring private runtime network...'
docker network inspect "`$NETWORK" >/dev/null 2>&1 || docker network create "`$NETWORK"

printf '%s\n' '[deploy] Starting new container...'
docker run -d --name "`$CONTAINER" --restart unless-stopped \
  --network "`$NETWORK" --network-alias wqn \
  --env-file "`$ENV_FILE" -p "`$PORT_MAP" "`$IMAGE"

printf '%s\n' '[deploy] Pruning unused images...'
docker image prune -f

printf '%s\n' '[deploy] WQN deploy complete.'
"@

    $remoteScript | & ssh $AliyunSshHost "bash -s"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Aliyun remote deploy failed." -ForegroundColor Red
        exit 1
    }

    Write-Step "Aliyun deploy complete." "Green"
}

# ============================================================
# Load and validate configuration
# ============================================================

Write-Host ""
Write-Host "  Loading .env.production from:" -ForegroundColor Cyan
Write-Host "  $EnvFile" -ForegroundColor White

if (-not (Test-Path -LiteralPath $WebDir)) {
    Write-Host "  [ERROR] Web directory not found: $WebDir" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $Dockerfile)) {
    Write-Host "  [ERROR] Dockerfile not found: $Dockerfile" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host ""
    Write-Host "  [ERROR] .env.production not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please copy web/.env.production.template to web/.env.production and fill it in." -ForegroundColor Yellow
    exit 1
}

$script:EnvVars = Read-DotEnvFile -Path $EnvFile

Test-RequiredValues -Keys @(
    "ACR_SERVER",
    "ACR_NAMESPACE",
    "ACR_REPO",
    "ACR_USERNAME",
    "ACR_PASSWORD",
    "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"
)

if ($DeployAliyun) {
    Test-RequiredValues -Keys @(
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
        "WQN_SUPABASE_EXPECTED_HOST",
        "SUPABASE_SECRET_KEY",
        "WQN_REALTIME_PROXY_SECRET",
        "WQN_INTERNAL_API_ALLOWED_HOST"
    )
}

$AcrServer = Get-EnvValue "ACR_SERVER"
$AcrNamespace = Get-EnvValue "ACR_NAMESPACE"
$AcrRepo = Get-EnvValue "ACR_REPO"
$AcrUsername = Get-EnvValue "ACR_USERNAME"
$AcrPassword = Get-EnvValue "ACR_PASSWORD"

$optionalBuildArgKeys = @(
    "BASE_NODE_IMAGE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY"
)

$publicBuildArgKeys = @(
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
    "WQN_SUPABASE_EXPECTED_HOST",
    "SITE_URL"
)

$script:RuntimeVarKeys = @(
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
    "WQN_SUPABASE_EXPECTED_HOST",
    "SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_APP_URL",
    "SITE_URL",
    "CRON_SECRET",
    "AI_PROVIDER",
    "AI_PROVIDER_BASE_URL",
    "AI_PROVIDER_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_MODEL_EXTRACTION",
    "AI_MODEL_CATEGORISATION",
    "AI_MODEL_DIGEST",
    "WQN_ESP32_AI_ASR_PROVIDER",
    "WQN_ESP32_AI_CHAT_PROVIDER",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_CHAT_API_KEY",
    "DASHSCOPE_CHAT_API_KEY_STD",
    "DASHSCOPE_CHAT_API_KEY_PRO",
    "DASHSCOPE_OPENAI_BASE_URL",
    "DASHSCOPE_OPENAI_BASE_URL_STD",
    "DASHSCOPE_OPENAI_BASE_URL_PRO",
    "DASHSCOPE_ASR_MODEL",
    "DASHSCOPE_ASR_TASK_URL",
    "DASHSCOPE_TASK_STATUS_BASE_URL",
    "DASHSCOPE_ASR_LANGUAGE_HINTS",
    "DASHSCOPE_ASR_POLL_INTERVAL_MS",
    "DASHSCOPE_ASR_POLL_ATTEMPTS",
    "DASHSCOPE_CHAT_MODEL",
    "DASHSCOPE_CHAT_MODEL_STD",
    "DASHSCOPE_CHAT_MODEL_PRO",
    "STEPFUN_API_KEY",
    "STEPFUN_ASR_URL",
    "STEPFUN_ASR_MODEL",
    "STEPFUN_ASR_LANGUAGE",
    "STEPFUN_ASR_HOTWORDS",
    "STEPFUN_ASR_ENABLE_ITN",
    "WQN_ESP32_AI_SYSTEM_PROMPT",
    "WQN_ESP32_AI_PUBLIC_BASE_URL",
    "WQN_ESP32_AI_AUDIO_URL_SECRET",
    "WQN_ESP32_AI_AUDIO_TMP_DIR",
    "WQN_ESP32_AI_AUDIO_URL_TTL_MS",
    "WQN_ESP32_AI_PROVIDER_TIMEOUT_MS",
    "WQN_ESP32_AI_LLM_TIMEOUT_MS",
    "WQN_ESP32_AI_ASR_TIMEOUT_MS",
    "WQN_ESP32_AI_STREAM_EVENT_ID_BASE",
    "WQN_REALTIME_PROXY_SECRET",
    "WQN_INTERNAL_API_ALLOWED_HOST",
    "SENTRY_DSN"
)

$buildArgKeys = $optionalBuildArgKeys + $publicBuildArgKeys

$missingAppVars = $publicBuildArgKeys | Where-Object {
    [string]::IsNullOrWhiteSpace((Get-EnvValue $_))
}

if ($missingAppVars) {
    Write-Host ""
    Write-Host "  [WARN] These public build args are empty and will not be embedded in the image:" -ForegroundColor Yellow
    $missingAppVars | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
}

$BuildArgs = New-BuildArgList -AppVarKeys $buildArgKeys

$script:BuildProxy = Get-EnvValue "WQN_BUILD_PROXY"
if ([string]::IsNullOrWhiteSpace($script:BuildProxy)) {
    $script:BuildProxy = Get-EnvValue "HTTPS_PROXY"
}
if ([string]::IsNullOrWhiteSpace($script:BuildProxy)) {
    $script:BuildProxy = Get-EnvValue "HTTP_PROXY"
}
if ([string]::IsNullOrWhiteSpace($script:BuildProxy)) {
    $script:BuildProxy = $DefaultBuildProxy
}
$script:BuildNoProxy = Get-EnvValue "NO_PROXY"
if ([string]::IsNullOrWhiteSpace($script:BuildNoProxy)) {
    $script:BuildNoProxy = "localhost,127.0.0.1,::1"
}
$script:ContainerBuildProxy = Convert-ToBuilderProxyUrl $script:BuildProxy

if (-not [string]::IsNullOrWhiteSpace($script:ContainerBuildProxy)) {
    $BuildArgs += @("--build-arg", "HTTP_PROXY=$script:ContainerBuildProxy")
    $BuildArgs += @("--build-arg", "HTTPS_PROXY=$script:ContainerBuildProxy")
    $BuildArgs += @("--build-arg", "http_proxy=$script:ContainerBuildProxy")
    $BuildArgs += @("--build-arg", "https_proxy=$script:ContainerBuildProxy")
}
if (-not [string]::IsNullOrWhiteSpace($script:BuildNoProxy)) {
    $BuildArgs += @("--build-arg", "NO_PROXY=$script:BuildNoProxy")
    $BuildArgs += @("--build-arg", "no_proxy=$script:BuildNoProxy")
}

$ImageBase = "${AcrServer}/${AcrNamespace}/${AcrRepo}"
$ImageTag = "${ImageBase}:${Tag}"
$BaseNodeImage = Get-EnvValue "BASE_NODE_IMAGE"
if ([string]::IsNullOrWhiteSpace($BaseNodeImage)) {
    $BaseNodeImage = "node:24-alpine"
}

# ============================================================
# Main
# ============================================================

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  WQN Build & Push to ACR" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  ACR Server:   $AcrServer" -ForegroundColor White
Write-Host "  Namespace:    $AcrNamespace" -ForegroundColor White
Write-Host "  Repo:         $AcrRepo" -ForegroundColor White
Write-Host "  Tag:          $Tag" -ForegroundColor White
Write-Host "  Image:        $ImageTag" -ForegroundColor DarkGray
Write-Host "  Base image:   $BaseNodeImage" -ForegroundColor DarkGray
Write-Host "  Build proxy:  $script:BuildProxy" -ForegroundColor DarkGray
Write-Host "  Container proxy: $script:ContainerBuildProxy" -ForegroundColor DarkGray
Write-Host "  Deploy ECS:   $DeployAliyun" -ForegroundColor DarkGray
if ($DeployAliyun) {
    Write-Host "  SSH Host:     $AliyunSshHost" -ForegroundColor DarkGray
    Write-Host "  Container:    $AliyunContainerName" -ForegroundColor DarkGray
    Write-Host "  Port map:     $AliyunPortMap" -ForegroundColor DarkGray
    Write-Host "  Network:      $AliyunNetworkName" -ForegroundColor DarkGray
}
Write-Host ""

$TotalSteps = if ($DeployAliyun) { 5 } else { 4 }

# Step 1: Login
Write-Host "  [Step 1/$TotalSteps] Logging into ACR..." -ForegroundColor Yellow
Invoke-DockerLogin -Server $AcrServer -Username $AcrUsername -Password $AcrPassword
Write-Step "Logged in." "Green"

# Step 2: Check Buildx
Write-Host ""
Write-Host "  [Step 2/$TotalSteps] Checking Docker Buildx..." -ForegroundColor Yellow
Test-DockerBuildx
Initialize-Buildx

# Step 3: Build
Write-Host ""
Write-Host "  [Step 3/$TotalSteps] Building and pushing linux/amd64 image..." -ForegroundColor Yellow
Invoke-DockerBuild -BuildArgs $BuildArgs
Write-Step "Build + push complete." "Green"

# Step 4: Optional ECS deploy
if ($DeployAliyun) {
    Write-Host ""
    Write-Host "  [Step 4/$TotalSteps] Deploying to Aliyun ECS..." -ForegroundColor Yellow
    Invoke-AliyunDeploy
}

# Final step: Done
Write-Host ""
Write-Host "  [Step $TotalSteps/$TotalSteps] Done." -ForegroundColor Green

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Done! Image is available in ACR." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pull on ECS:" -ForegroundColor Yellow
Write-Host "    docker pull $ImageTag" -ForegroundColor White
if ($DeployAliyun) {
    Write-Host ""
    Write-Host "  ECS deploy target:" -ForegroundColor Yellow
    Write-Host "    ssh $AliyunSshHost" -ForegroundColor White
    Write-Host "    docker ps --filter name=$AliyunContainerName" -ForegroundColor White
}
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
