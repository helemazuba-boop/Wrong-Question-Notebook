# ============================================================
# WQN Build & Push Script (Windows PowerShell)
# ============================================================
# Builds Docker images for BOTH architectures in PARALLEL and
# pushes each to Alibaba Cloud ACR (personal tier) immediately
# after the respective build finishes:
#   - :{tag}-arm64  →  Home Router (Rockchip ARMv8, 1GB RAM)
#   - :{tag}-amd64  →  Alibaba Cloud ECS (x86_64, 2GB RAM)
#
# NOTE: ACR Personal does not support manifest lists, so we
# use architecture-specific tags instead. Each deployment
# machine pulls its own tag.
#
# Docker Buildx handles cross-compilation via QEMU on the
# local x86_64 machine.
#
# PREREQUISITES:
#   - Docker Desktop installed and running
#   - Docker Desktop: Settings → General → "Enable container images"
#   - .env.production filled with all required values
#
# USAGE:
#   .\build-and-push.ps1                    # reads credentials from .env.production
#   .\build-and-push.ps1 -Tag "v1.2.3"     # with version tag
# ============================================================

param(
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

# ---------- Paths ----------
$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$WebDir = Join-Path $ProjectRoot "web"
$Dockerfile = Join-Path $WebDir "Dockerfile"
$EnvFile = Join-Path $WebDir ".env.production"

# ---------- Load .env.production ----------
Write-Host ""
Write-Host "  Loading .env.production from:" -ForegroundColor Cyan
Write-Host "  $EnvFile" -ForegroundColor White

if (-not (Test-Path $EnvFile)) {
    Write-Host ""
    Write-Host "  [ERROR] .env.production not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please fill in .env.production and try again." -ForegroundColor Yellow
    exit 1
}

$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line -match '^([^=]+)=(.*)$') {
        $key = $Matches[1].Trim()
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        $envVars[$key] = $value
    }
}

# ---------- Validate required ACR fields ----------
$required = @('ACR_SERVER', 'ACR_NAMESPACE', 'ACR_REPO', 'ACR_USERNAME', 'ACR_PASSWORD')
$missing = $required | Where-Object { [string]::IsNullOrWhiteSpace($envVars[$_]) }
if ($missing) {
    Write-Host ""
    Write-Host "  [ERROR] Missing required fields in .env.production:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    exit 1
}

# ---------- Validate required memory tuning fields ----------
$memRequired = @('ARM64_CONTAINER_NODE_OPTIONS', 'AMD64_CONTAINER_NODE_OPTIONS')
$memMissing = $memRequired | Where-Object { [string]::IsNullOrWhiteSpace($envVars[$_]) }
if ($memMissing) {
    Write-Host ""
    Write-Host "  [ERROR] Missing memory tuning fields in .env.production:" -ForegroundColor Red
    $memMissing | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    exit 1
}

$AcrServer    = $envVars['ACR_SERVER']
$AcrNamespace = $envVars['ACR_NAMESPACE']
$AcrRepo      = $envVars['ACR_REPO']
$AcrUsername  = $envVars['ACR_USERNAME']
$AcrPassword  = $envVars['ACR_PASSWORD']

# ---------- Per-architecture build args ----------
# Memory tuning — read from .env.production so values are explicit and auditable.
$ArchNodeOptions = @{
    'amd64' = $envVars['AMD64_CONTAINER_NODE_OPTIONS']
    'arm64' = $envVars['ARM64_CONTAINER_NODE_OPTIONS']
}

# App env vars forwarded as --build-arg for ALL architectures.
$appVarKeys = @(
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'SITE_URL'
)

function Build-Arg-List {
    param([string]$Arch)
    $args = @()
    foreach ($key in $appVarKeys) {
        if (-not [string]::IsNullOrWhiteSpace($envVars[$key])) {
            $escaped = $envVars[$key] -replace '\\', '\\\\'
            $args += "--build-arg ${key}=${escaped}"
        }
    }
    $escapedOpts = $ArchNodeOptions[$Arch] -replace '\\', '\\\\'
    $args += "--build-arg CONTAINER_NODE_OPTIONS=${escapedOpts}"
    return $args
}

$Amd64BuildArgs = Build-Arg-List -Arch 'amd64'
$Arm64BuildArgs = Build-Arg-List -Arch 'arm64'

$ImageBase = "${AcrServer}/${AcrNamespace}/${AcrRepo}"
$Amd64Tag = "${ImageBase}:${Tag}-amd64"
$Arm64Tag = "${ImageBase}:${Tag}-arm64"

# ============================================================
# Helper functions
# ============================================================

function Write-Step {
    param([string]$Msg, [string]$Color = "Yellow")
    Write-Host "  [$((Get-Date).ToString('HH:mm:ss'))] $Msg" -ForegroundColor $Color
}

function Test-DockerBuildx {
    $out = docker buildx version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  [ERROR] Docker Buildx is not available." -ForegroundColor Red
        Write-Host "  Please ensure Docker Desktop is installed and running." -ForegroundColor Yellow
        exit 1
    }
    Write-Step "Docker Buildx available: $out" "Cyan"
}

function Initialize-Buildx {
    $builderName = "wqn-builder"

    Write-Step "Checking Buildx builder: $builderName"

    $existingOut = docker buildx inspect $builderName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Step "Creating new docker-container builder: $builderName" "Yellow"
        $createOut = docker buildx create --name $builderName --driver docker-container 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] Failed to create builder: $createOut" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Step "Using existing builder." "Cyan"
    }

    docker buildx use $builderName 2>&1 | Out-Null

    Write-Step "Bootstrapping builder (downloads QEMU if needed)..." -ForegroundColor Yellow
    docker buildx inspect $builderName --bootstrap 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Builder bootstrap failed." -ForegroundColor Red
        exit 1
    }
    Write-Step "Builder ready." "Green"
}

function Invoke-Build {
    param(
        [string]$Arch,
        [string]$Tag,
        [string]$Platform,
        [string[]]$BuildArgs
    )

    Write-Step "Building $Arch image ($Platform)..." "Yellow"
    Write-Host "    Tag: $Tag" "DarkGray"

    $argLine = ($BuildArgs | ForEach-Object { $_.Replace("--build-arg ", "") }) -join ' '
    Write-Step "Build args: $argLine" "DarkGray"

    Push-Location $WebDir
    try {
        docker buildx build `
            --platform $Platform `
            --builder wqn-builder `
            --push `
            -t $Tag `
            -f $Dockerfile `
            $BuildArgs `
            .

        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "  [ERROR] Build failed for $Arch ($Platform)." -ForegroundColor Red
            Pop-Location
            return $false
        }
    } finally {
        Pop-Location
    }

    Write-Step "Build + push complete: $Arch" "Green"
    return $true
}

# ============================================================
# Main
# ============================================================

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  WQN Multi-Arch Build & Push to ACR" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  ACR Server:   $AcrServer" -ForegroundColor White
Write-Host "  Namespace:     $AcrNamespace" -ForegroundColor White
Write-Host "  Repo:         $AcrRepo" -ForegroundColor White
Write-Host "  Tag:          $Tag" -ForegroundColor White
Write-Host "  ARM64:        $Arm64Tag" -ForegroundColor DarkGray
Write-Host "               NODE_OPTIONS=$($ArchNodeOptions['arm64'])" -ForegroundColor DarkGray
Write-Host "  AMD64:        $Amd64Tag" -ForegroundColor DarkGray
Write-Host "               NODE_OPTIONS=$($ArchNodeOptions['amd64'])" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Login
Write-Host "  [Step 1/4] Logging into ACR..." -ForegroundColor Yellow
$AcrPassword | docker login $AcrServer --username $AcrUsername --password-stdin
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] ACR login failed." -ForegroundColor Red
    exit 1
}
Write-Step "Logged in." "Green"

# Step 2: Check Buildx
Write-Host ""
Write-Host "  [Step 2/4] Checking Docker Buildx..." -ForegroundColor Yellow
Test-DockerBuildx
Initialize-Buildx

# Step 3: Build both architectures IN PARALLEL
Write-Host ""
Write-Host "  [Step 3/4] Building and pushing in parallel..." -ForegroundColor Yellow

$amd64Job = Start-Job -ScriptBlock {
    param($Arch, $Tag, $Platform, $BuildArgs, $WebDir, $Dockerfile)
    Push-Location $WebDir
    try {
        docker buildx build `
            --platform $Platform `
            --builder wqn-builder `
            --push `
            -t $Tag `
            -f $Dockerfile `
            $BuildArgs `
            .
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    @{ ExitCode = $exitCode; Arch = $Arch; Tag = $Tag }
} -ArgumentList 'amd64', $Amd64Tag, 'linux/amd64', $Amd64BuildArgs, $WebDir, $Dockerfile

$arm64Job = Start-Job -ScriptBlock {
    param($Arch, $Tag, $Platform, $BuildArgs, $WebDir, $Dockerfile)
    Push-Location $WebDir
    try {
        docker buildx build `
            --platform $Platform `
            --builder wqn-builder `
            --push `
            -t $Tag `
            -f $Dockerfile `
            $BuildArgs `
            .
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    @{ ExitCode = $exitCode; Arch = $Arch; Tag = $Tag }
} -ArgumentList 'arm64', $Arm64Tag, 'linux/arm64', $Arm64BuildArgs, $WebDir, $Dockerfile

# Wait for each job and report as it completes
$jobs = @($amd64Job, $arm64Job)
while ($jobs.Count -gt 0) {
    $completed = $jobs | Where-Object { $_.State -eq 'Completed' -or $_.State -eq 'Failed' }
    foreach ($job in $completed) {
        $result = Receive-Job -Job $job
        if ($result.ExitCode -eq 0) {
            Write-Step "Build + push complete: $($result.Arch) → $($result.Tag)" "Green"
        } else {
            Write-Host ""
            Write-Host "  [ERROR] Build failed for $($result.Arch)." -ForegroundColor Red
            Write-Host "  Exiting." -ForegroundColor Red
            # Clean up remaining jobs
            $jobs | Stop-Job
            $jobs | Remove-Job
            exit 1
        }
        Remove-Job -Job $job
        $jobs = @($jobs | Where-Object { $_ -ne $job })
    }
    if ($jobs.Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
}

Write-Host ""
Write-Host "  [Step 4/4] All builds complete." -ForegroundColor Green

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Done! Both images are available in ACR." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pull on Router (ARM64):" -ForegroundColor Yellow
Write-Host "    docker pull $Arm64Tag" -ForegroundColor White
Write-Host ""
Write-Host "  Pull on ECS (amd64):" -ForegroundColor Yellow
Write-Host "    docker pull $Amd64Tag" -ForegroundColor White
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
