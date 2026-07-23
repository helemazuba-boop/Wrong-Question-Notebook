# ============================================================
# WQN Realtime Build & Push Script (Windows PowerShell)
# ============================================================
# Builds the Bun-based wqn-realtime image for linux/amd64 and
# pushes it to Alibaba Cloud ACR.
#
# This is a thin companion to build-and-push.ps1 — it does NOT
# deploy to ECS. The .bat wrapper (or ECS bootstrap script) is
# responsible for pulling and starting the container.
#
# PREREQUISITES:
#   - Docker Desktop installed and running
#   - Docker Buildx available
#   - web/.env.production filled with all required values
#
# USAGE:
#   .\deploy\build-and-push-realtime.ps1
#   .\deploy\build-and-push-realtime.ps1 -Tag "v1.2.3"
# ============================================================

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$Tag = "latest",

    [switch]$RecreateBuilder,

    [string]$RealtimeRepo = "wqn-realtime"
)

$ErrorActionPreference = "Stop"

# ---------- Paths ----------
$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$WebDir = Join-Path $ProjectRoot "web"
$Dockerfile = Join-Path $WebDir "Dockerfile.realtime"
$EnvFile = Join-Path $WebDir ".env.production"
$BuildkitConfig = Join-Path $ScriptRoot "buildkit-config.toml"
$BuildkitConfigHashFile = Join-Path $ScriptRoot ".wqn-realtime-builder-config.hash"
$BuilderName = "wqn-realtime-builder"
$DefaultBuildProxy = "http://127.0.0.1:7890"

# ============================================================
# Helper functions (subset of build-and-push.ps1)
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

    $placeholders = @(
        "your_anon_key_here",
        "your_service_role_key_here",
        "your_dashscope_api_key_here",
        "replace_with_32_byte_base64_key",
        "replace_with_long_random_secret",
        "https://data.example.invalid",
        "https://your-domain.com",
        "sk-replace_me",
        "replace_with_stepfun_api_key"
    )

    $missing = @()
    foreach ($key in $Keys) {
        $value = Get-EnvValue $key
        if ([string]::IsNullOrWhiteSpace($value) -or $placeholders -contains $value) {
            $missing += $key
        }
    }

    if ($missing) {
        Write-Host ""
        Write-Host "  [ERROR] Missing or placeholder required fields in .env.production:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        exit 1
    }
}

function Invoke-DockerCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
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
            try { $process.Kill() } catch { }
            Write-Host "  [ERROR] ACR login timed out after ${TimeoutSeconds}s." -ForegroundColor Red
            exit 1
        }

        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0) {
            Write-Host "  [ERROR] ACR login failed." -ForegroundColor Red
            if (-not [string]::IsNullOrWhiteSpace($stdout)) { Write-Host $stdout.Trim() -ForegroundColor Yellow }
            if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Host $stderr.Trim() -ForegroundColor Yellow }
            exit 1
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
        }
    }

    $existing = Invoke-DockerCapture -Arguments @("buildx", "inspect", $BuilderName)

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
        exit 1
    }
}

function Invoke-DockerBuild {
    $dockerArgs = @(
        "buildx", "build",
        "--platform", "linux/amd64",
        "--builder", $BuilderName,
        "--provenance=false",
        "--push",
        "-t", $ImageTag,
        "-f", $Dockerfile
    )

    Push-Location $WebDir
    try {
        $oldHttpProxy = $env:HTTP_PROXY
        $oldHttpsProxy = $env:HTTPS_PROXY
        $oldLowerHttpProxy = $env:http_proxy
        $oldLowerHttpsProxy = $env:https_proxy
        $oldNoProxy = $env:NO_PROXY
        $oldLowerNoProxy = $env:no_proxy

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

        & docker @dockerArgs .
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] wqn-realtime build failed." -ForegroundColor Red
            exit 1
        }
    } finally {
        $env:HTTP_PROXY = $oldHttpProxy
        $env:HTTPS_PROXY = $oldHttpsProxy
        $env:http_proxy = $oldLowerHttpProxy
        $env:https_proxy = $oldLowerHttpsProxy
        $env:NO_PROXY = $oldNoProxy
        $env:no_proxy = $oldLowerNoProxy
        Pop-Location
    }
}

# ============================================================
# Load and validate configuration
# ============================================================

Write-Host ""
Write-Host "  Loading .env.production from:" -ForegroundColor Cyan
Write-Host "  $EnvFile" -ForegroundColor White

if (-not (Test-Path -LiteralPath $Dockerfile)) {
    Write-Host "  [ERROR] Dockerfile.realtime not found: $Dockerfile" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host ""
    Write-Host "  [ERROR] .env.production not found!" -ForegroundColor Red
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
    "STEP_API_KEY",
    "WQN_REALTIME_PROXY_SECRET",
    "WQN_INTERNAL_API_BASE"
)

$AcrServer = Get-EnvValue "ACR_SERVER"
$AcrNamespace = Get-EnvValue "ACR_NAMESPACE"
$AcrUsername = Get-EnvValue "ACR_USERNAME"
$AcrPassword = Get-EnvValue "ACR_PASSWORD"

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

$ImageTag = "${AcrServer}/${AcrNamespace}/${RealtimeRepo}:${Tag}"

# ============================================================
# Main
# ============================================================

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  WQN Realtime Build & Push to ACR" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  ACR Server:     $AcrServer" -ForegroundColor White
Write-Host "  Namespace:      $AcrNamespace" -ForegroundColor White
Write-Host "  Realtime repo:  $RealtimeRepo" -ForegroundColor White
Write-Host "  Tag:            $Tag" -ForegroundColor White
Write-Host "  Image:          $ImageTag" -ForegroundColor DarkGray
Write-Host "  Build proxy:    $script:BuildProxy" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Login
Write-Host "  [Step 1/4] Logging into ACR..." -ForegroundColor Yellow
Invoke-DockerLogin -Server $AcrServer -Username $AcrUsername -Password $AcrPassword
Write-Step "Logged in." "Green"

# Step 2: Buildx
Write-Host ""
Write-Host "  [Step 2/4] Initializing Docker Buildx..." -ForegroundColor Yellow
Initialize-Buildx

# Step 3: Build
Write-Host ""
Write-Host "  [Step 3/4] Building and pushing wqn-realtime linux/amd64 image..." -ForegroundColor Yellow
Invoke-DockerBuild
Write-Step "Build + push complete." "Green"

# Step 4: Done
Write-Host ""
Write-Host "  [Step 4/4] Done." -ForegroundColor Green

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Done! Image available in ACR." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pull on ECS:" -ForegroundColor Yellow
Write-Host "    docker pull $ImageTag" -ForegroundColor White
Write-Host "    .\deploy\deploy-realtime-remote.ps1 -Tag $Tag" -ForegroundColor White
Write-Host ""
Write-Host "  Verify:" -ForegroundColor Yellow
Write-Host "    curl http://127.0.0.1:8080/health" -ForegroundColor White
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
