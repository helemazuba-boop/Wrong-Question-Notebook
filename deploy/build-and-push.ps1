# ============================================================
# WQN Build & Push Script (Windows PowerShell)
# ============================================================
# Builds the Docker image for linux/amd64 and pushes it to
# Alibaba Cloud ACR (personal tier).
#
# NOTE: ACR Personal does not support manifest lists.
#
# Docker Buildx handles the build on the local x86_64 machine.
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

# ---------- Validate required memory tuning field ----------
$memRequired = @('AMD64_CONTAINER_NODE_OPTIONS')
$memMissing = $memRequired | Where-Object { [string]::IsNullOrWhiteSpace($envVars[$_]) }
if ($memMissing) {
    Write-Host ""
    Write-Host "  [ERROR] Missing memory tuning field in .env.production:" -ForegroundColor Red
    $memMissing | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    exit 1
}

$AcrServer    = $envVars['ACR_SERVER']
$AcrNamespace = $envVars['ACR_NAMESPACE']
$AcrRepo      = $envVars['ACR_REPO']
$AcrUsername  = $envVars['ACR_USERNAME']
$AcrPassword  = $envVars['ACR_PASSWORD']

# ---------- Build args ----------
$NodeOptions = $envVars['AMD64_CONTAINER_NODE_OPTIONS']

# App env vars forwarded as --build-arg.
$appVarKeys = @(
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'SITE_URL'
)

function Build-Arg-List {
    $args = @()
    foreach ($key in $appVarKeys) {
        if (-not [string]::IsNullOrWhiteSpace($envVars[$key])) {
            $escaped = $envVars[$key] -replace '\\', '\\\\' -replace '"', '\"'
            $args += "--build-arg ${key}=`"${escaped}`""
        }
    }
    $escapedOpts = $NodeOptions -replace '\\', '\\\\' -replace '"', '\"'
    $args += "--build-arg CONTAINER_NODE_OPTIONS=`"${escapedOpts}`""
    return $args
}

$BuildArgs = Build-Arg-List

$ImageBase = "${AcrServer}/${AcrNamespace}/${AcrRepo}"
$ImageTag = "${ImageBase}:${Tag}"

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

    Write-Step "Checking builder status..." -ForegroundColor Yellow
    $inspectOutput = docker buildx inspect $builderName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Cannot inspect builder: $inspectOutput" -ForegroundColor Red
        exit 1
    }

    if ($inspectOutput -match "Status:\s*running") {
        Write-Step "Builder is running." "Green"
    } else {
        Write-Step "Bootstrapping builder..." -ForegroundColor Yellow
        docker buildx inspect $builderName --bootstrap 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] Builder bootstrap failed." -ForegroundColor Red
            exit 1
        }
        Write-Step "Builder ready." "Green"
    }
}

# ============================================================
# Main
# ============================================================

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  WQN Build & Push to ACR" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  ACR Server:   $AcrServer" -ForegroundColor White
Write-Host "  Namespace:     $AcrNamespace" -ForegroundColor White
Write-Host "  Repo:         $AcrRepo" -ForegroundColor White
Write-Host "  Tag:          $Tag" -ForegroundColor White
Write-Host "  Image:        $ImageTag" -ForegroundColor DarkGray
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

# Step 3: Build
Write-Host ""
Write-Host "  [Step 3/4] Building image..." -ForegroundColor Yellow

$buildCmd = "docker buildx build --platform linux/amd64 --builder wqn-builder --push -t `"$ImageTag`" -f `"$Dockerfile`" " + ($BuildArgs -join ' ') + " ."

Push-Location $WebDir
try {
    Invoke-Expression $buildCmd
    if ($LASTEXITCODE -ne 0) { Write-Host "  [ERROR] build failed." -ForegroundColor Red; exit 1 }
} finally { Pop-Location }
Write-Step "Build + push complete." "Green"

Write-Host ""
Write-Host "  [Step 4/4] Done." -ForegroundColor Green

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Done! Image is available in ACR." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pull on ECS:" -ForegroundColor Yellow
Write-Host "    docker pull $ImageTag" -ForegroundColor White
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
