#!/usr/bin/env bash
# ============================================================
# WQN Web release - WSL/bash port of web-release.bat
# ============================================================
# Builds the Next.js (wqn-app) and wqn-realtime Docker images,
# pushes them to Alibaba Cloud ACR, and deploys wqn-realtime to
# the Aliyun ECS host.
#
# This is a thin orchestrator: the real build/push/deploy logic
# lives in the *.ps1 scripts, which are run via `pwsh` (PowerShell
# on Linux). The .ps1 scripts are cross-platform (they use
# $PSScriptRoot / Join-Path / Get-Content / docker / ssh).
#
# PREREQUISITES:
#   - pwsh installed on WSL (PowerShell 7+ on Linux)
#   - docker reachable from WSL (Docker Desktop WSL integration)
#   - ssh client + an `aliyun` SSH host configured in ~/.ssh/config
#   - web/.env.production filled with all required values
#
# USAGE:
#   ./web-release.sh                    # build + push + deploy, auto tag
#   ./web-release.sh v1.2.3             # explicit app tag
#   ./web-release.sh --no-deploy        # build + push only, no ECS deploy
#   ./web-release.sh --skip-realtime    # app only, skip wqn-realtime
#   ./web-release.sh --rt-tag my-rt-1   # override realtime tag
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/web"
PS_APP_SCRIPT="$SCRIPT_DIR/build-and-push.ps1"
PS_REALTIME_SCRIPT="$SCRIPT_DIR/build-and-push-realtime.ps1"
PS_DEPLOY_RT_SCRIPT="$SCRIPT_DIR/deploy-realtime-remote.ps1"
ENV_FILE="$WEB_DIR/.env.production"

# ---------- preflight: scripts + env file ----------
for f in "$PS_APP_SCRIPT" "$PS_REALTIME_SCRIPT" "$PS_DEPLOY_RT_SCRIPT"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: script not found: $f" >&2
    exit 1
  fi
done
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing production env file: $ENV_FILE" >&2
  echo "Copy web/.env.production.template to web/.env.production and fill it in." >&2
  exit 1
fi
if ! command -v pwsh >/dev/null 2>&1; then
  echo "ERROR: 'pwsh' (PowerShell on Linux) not found on PATH." >&2
  echo "       Install: https://learn.microsoft.com/powershell/scripting/install/install-ubuntu" >&2
  exit 1
fi

# ---------- arg parsing (mirrors web-release.bat) ----------
NO_DEPLOY=0
SKIP_REALTIME=0
APP_TAG=""
RT_TAG=""

while (( $# )); do
  case "$1" in
    --no-deploy|-NoDeploy)     NO_DEPLOY=1; shift ;;
    --skip-realtime|-SkipRealtime) SKIP_REALTIME=1; shift ;;
    --rt-tag)
      shift
      if [[ -z "${1:-}" ]]; then
        echo "ERROR: --rt-tag requires a value." >&2
        exit 1
      fi
      RT_TAG="$1"; shift ;;
    -*) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$APP_TAG" ]]; then
        APP_TAG="$1"; shift
      else
        echo "ERROR: Unexpected argument: $1" >&2
        exit 1
      fi ;;
  esac
done

# ---------- default APP_TAG = STAMP-GITSHA ----------
if [[ -z "$APP_TAG" ]]; then
  GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  APP_TAG="${STAMP}-${GIT_SHA}"
fi
if [[ -z "$RT_TAG" ]]; then
  RT_TAG="${APP_TAG}-rt"
fi

echo "WQN Web release"
echo "Project:      $PROJECT_ROOT"
echo "Web dir:      $WEB_DIR"
echo "App tag:      $APP_TAG"
echo "Realtime tag: $RT_TAG"
if (( NO_DEPLOY )); then echo "Deploy: disabled"; else echo "Deploy: Aliyun ECS"; fi
if (( SKIP_REALTIME )); then echo "Realtime: skipped"; else echo "Realtime: wqn-realtime included"; fi
echo

# ---------- required-env check (port of the inline PowerShell check) ----------
check_required_env() {
  declare -A vars=()
  local raw line key value
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="${raw#"${raw%%[![:space:]]*}"}"   # ltrim
    [[ -z "$line" || "$line" == "#"* ]] && continue
    [[ "$line" == "export "* ]] && line="${line#export }"
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value%"${value##*[![:space:]]}"}"   # rtrim
      if [[ "$value" == \"*\" ]]; then value="${value:1:-1}"; fi
      if [[ "$value" == \'*\' ]]; then value="${value:1:-1}"; fi
      vars["$key"]="$value"
    fi
  done < "$ENV_FILE"

  local required=(
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
    NEXT_PUBLIC_SUPABASE_URL
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
    SUPABASE_SECRET_KEY
    DASHSCOPE_API_KEY
    WQN_ESP32_AI_PUBLIC_BASE_URL
    WQN_ESP32_AI_AUDIO_URL_SECRET
    STEP_API_KEY
    WQN_REALTIME_PROXY_SECRET
    WQN_INTERNAL_API_BASE
  )
  local placeholders=(
    your_anon_key_here
    sb_secret_replace_me
    your_dashscope_api_key_here
    replace_with_32_byte_base64_key
    replace_with_long_random_secret
    https://data.example.invalid
    https://your-domain.com
    replace_with_stepfun_api_key
  )
  local bad=() k v ph
  for k in "${required[@]}"; do
    v="${vars[$k]:-}"
    if [[ -z "$v" ]]; then
      bad+=("$k"); continue
    fi
    for ph in "${placeholders[@]}"; do
      if [[ "$v" == "$ph" ]]; then bad+=("$k"); break; fi
    done
  done
  if (( ${#bad[@]} > 0 )); then
    echo "ERROR: Required env values are missing or still placeholders:" >&2
    local b
    for b in "${bad[@]}"; do echo "  $b" >&2; done
    return 1
  fi
  return 0
}

if ! check_required_env; then
  echo >&2
  echo "ERROR: Web release failed." >&2
  exit 1
fi

# ---------- app build + push ----------
echo "[release] Starting app build and push..."
if (( NO_DEPLOY )); then
  pwsh -NoProfile -File "$PS_APP_SCRIPT" -Tag "$APP_TAG" \
    || { echo "ERROR: app build/push failed." >&2; exit 1; }
else
  pwsh -NoProfile -File "$PS_APP_SCRIPT" -Tag "$APP_TAG" -DeployAliyun \
    || { echo "ERROR: app build/push failed." >&2; exit 1; }
fi

# ---------- realtime build + push + deploy ----------
if (( ! SKIP_REALTIME )); then
  echo
  echo "[release] Starting wqn-realtime build and push (tag $RT_TAG)..."
  pwsh -NoProfile -File "$PS_REALTIME_SCRIPT" -Tag "$RT_TAG" \
    || { echo "ERROR: realtime build/push failed." >&2; exit 1; }

  if (( ! NO_DEPLOY )); then
    echo
    echo "[release] Deploying wqn-realtime to Aliyun ECS..."
    pwsh -NoProfile -File "$PS_DEPLOY_RT_SCRIPT" -Tag "$RT_TAG" \
      || { echo "ERROR: realtime deploy failed." >&2; exit 1; }
  fi
fi

cat <<'EOF'

Web release complete.

Reminders:
  1. Add these to nginx on ECS:
       location = /api/esp32/realtime {
           proxy_pass http://127.0.0.1:8080/api/esp32/realtime;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_read_timeout 1h;
           proxy_send_timeout 1h;
           proxy_buffering off;
       }
  2. Run 'sudo nginx -t && sudo nginx -s reload' on ECS.
  3. Verify: curl -i --upgrade https://wqn.helema.cn/api/esp32/realtime
EOF
exit 0
