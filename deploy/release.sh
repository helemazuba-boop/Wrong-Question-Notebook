#!/usr/bin/env bash
set -Eeuo pipefail

# WQN native WSL release orchestrator
# - Runs entirely from Ubuntu/WSL
# - Builds App + Realtime in parallel
# - Pushes both images before any deploy happens
# - Direct network by default; only WQN_BUILD_PROXY explicitly enables a build proxy
# - Uses Docker Desktop through WSL Integration

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$PROJECT_ROOT/web"
ENV_FILE="$WEB_DIR/.env.production"
BUILDKIT_CONFIG="$SCRIPT_DIR/buildkit-config.toml"

APP_BUILDER="wqn-builder"
RT_BUILDER="wqn-realtime-builder"
APP_BUILDER_HASH_FILE="$SCRIPT_DIR/.wqn-builder-config.hash"
RT_BUILDER_HASH_FILE="$SCRIPT_DIR/.wqn-realtime-builder-config.hash"

NO_DEPLOY=0
SKIP_REALTIME=0
RECREATE_BUILDERS=0
APP_TAG=""
RT_TAG=""
SSH_HOST="aliyun"
APP_CONTAINER="wqn-app"
APP_PORT="3000:3000"
RT_CONTAINER="wqn-realtime"
RT_PORT="127.0.0.1:8080:8080"
RUNTIME_NETWORK="wqn-runtime"
REMOTE_ENV_FILE=".env.production"
RT_REPO="wqn-realtime"

usage() {
  cat <<'USAGE'
Usage:
  ./deploy/release.sh [APP_TAG] [options]

Options:
  --tag TAG                 App image tag (same as positional APP_TAG)
  --rt-tag TAG              Realtime image tag (default: APP_TAG-rt)
  --no-deploy               Build + push only
  --skip-realtime           Skip Realtime build/deploy
  --recreate-builders       Force recreation of both Buildx builders
  --ssh-host HOST           ECS SSH host/alias (default: aliyun)
  --app-container NAME      App container name (default: wqn-app)
  --app-port HOST:CONTAINER App port mapping (default: 3000:3000)
  --rt-container NAME       Realtime container name (default: wqn-realtime)
  --rt-port HOST:CONTAINER  Realtime port mapping (default: 127.0.0.1:8080:8080)
  --network NAME            Docker runtime network (default: wqn-runtime)
  --remote-env PATH         Remote env file; relative paths are under $HOME
  -h, --help                Show help

Network policy:
  Normal release: direct via Docker Desktop -> F50P/OpenClash.
  Emergency explicit proxy only:
    WQN_BUILD_PROXY=http://127.0.0.1:7897 ./deploy/release.sh
  Optional bypass list:
    WQN_BUILD_NO_PROXY=localhost,127.0.0.1,::1
USAGE
}

while (($#)); do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || { echo "ERROR: --tag requires a value" >&2; exit 2; }
      APP_TAG="$2"; shift 2 ;;
    --rt-tag)
      [[ $# -ge 2 ]] || { echo "ERROR: --rt-tag requires a value" >&2; exit 2; }
      RT_TAG="$2"; shift 2 ;;
    --no-deploy)
      NO_DEPLOY=1; shift ;;
    --skip-realtime)
      SKIP_REALTIME=1; shift ;;
    --recreate-builders)
      RECREATE_BUILDERS=1; shift ;;
    --ssh-host)
      [[ $# -ge 2 ]] || { echo "ERROR: --ssh-host requires a value" >&2; exit 2; }
      SSH_HOST="$2"; shift 2 ;;
    --app-container)
      [[ $# -ge 2 ]] || { echo "ERROR: --app-container requires a value" >&2; exit 2; }
      APP_CONTAINER="$2"; shift 2 ;;
    --app-port)
      [[ $# -ge 2 ]] || { echo "ERROR: --app-port requires a value" >&2; exit 2; }
      APP_PORT="$2"; shift 2 ;;
    --rt-container)
      [[ $# -ge 2 ]] || { echo "ERROR: --rt-container requires a value" >&2; exit 2; }
      RT_CONTAINER="$2"; shift 2 ;;
    --rt-port)
      [[ $# -ge 2 ]] || { echo "ERROR: --rt-port requires a value" >&2; exit 2; }
      RT_PORT="$2"; shift 2 ;;
    --network)
      [[ $# -ge 2 ]] || { echo "ERROR: --network requires a value" >&2; exit 2; }
      RUNTIME_NETWORK="$2"; shift 2 ;;
    --remote-env)
      [[ $# -ge 2 ]] || { echo "ERROR: --remote-env requires a value" >&2; exit 2; }
      REMOTE_ENV_FILE="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    --*)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2 ;;
    *)
      if [[ -z "$APP_TAG" ]]; then
        APP_TAG="$1"
        shift
      else
        echo "ERROR: unexpected argument: $1" >&2
        exit 2
      fi ;;
  esac
done

TAG_RE='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
if [[ -n "$APP_TAG" && ! "$APP_TAG" =~ $TAG_RE ]]; then
  echo "ERROR: invalid app tag: $APP_TAG" >&2
  exit 2
fi
if [[ -n "$RT_TAG" && ! "$RT_TAG" =~ $TAG_RE ]]; then
  echo "ERROR: invalid realtime tag: $RT_TAG" >&2
  exit 2
fi
if [[ ! "$APP_PORT" =~ ^[0-9.:]+:[0-9]+$ ]]; then
  echo "ERROR: invalid --app-port: $APP_PORT" >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

step() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

require_cmd docker
require_cmd git
require_cmd python3
require_cmd ssh
require_cmd sha256sum
require_cmd sed
require_cmd base64

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing production env file: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$WEB_DIR/Dockerfile" ]]; then
  echo "ERROR: missing $WEB_DIR/Dockerfile" >&2
  exit 1
fi
if (( ! SKIP_REALTIME )) && [[ ! -f "$WEB_DIR/Dockerfile.realtime" ]]; then
  echo "ERROR: missing $WEB_DIR/Dockerfile.realtime" >&2
  exit 1
fi

# Load .env.production safely into an associative array. We deliberately do not
# `source` it, because dotenv files are data, not shell programs.
declare -A DOTENV=()
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  DOTENV["$key"]="$value"
done < <(
  python3 - "$ENV_FILE" <<'PY'
import re, sys
path = sys.argv[1]
pat = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$')
with open(path, encoding='utf-8-sig') as f:
    for n, raw in enumerate(f, 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        m = pat.match(line)
        if not m:
            raise SystemExit(f'Invalid .env.production line {n}: {raw.rstrip()}')
        key, value = m.group(1), m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        value = value.replace('\r', '').replace('\n', '')
        sys.stdout.buffer.write(key.encode() + b'\0' + value.encode() + b'\0')
PY
)

getv() {
  local key="$1"
  # Process environment deliberately wins, useful for one-shot overrides such
  # as WQN_BUILD_PROXY without editing .env.production.
  if [[ -v "$key" ]]; then
    printf '%s' "${!key}"
  elif [[ -v "DOTENV[$key]" ]]; then
    printf '%s' "${DOTENV[$key]}"
  fi
}

is_placeholder() {
  case "$1" in
    sb_publishable_replace_me|sb_secret_replace_me|your_anon_key_here|your_service_role_key_here|your_dashscope_api_key_here|replace_with_32_byte_base64_key|replace_with_long_random_secret|https://data.example.invalid|https://your-domain.com|https://your-project-id.supabase.co|replace_with_stepfun_api_key|sk-replace_me)
      return 0 ;;
    *) return 1 ;;
  esac
}

require_values() {
  local missing=() key value
  for key in "$@"; do
    value="$(getv "$key")"
    if [[ -z "$value" ]] || is_placeholder "$value"; then
      missing+=("$key")
    fi
  done
  if ((${#missing[@]})); then
    echo "ERROR: required .env.production values are missing/placeholders:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
  fi
}

# Build/push requirements from the existing WQN release scripts.
require_values \
  ACR_SERVER ACR_NAMESPACE ACR_REPO ACR_USERNAME ACR_PASSWORD \
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

# Keep the production-level checks previously performed by web-release.bat.
if (( ! NO_DEPLOY )); then
  require_values \
    NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY \
    WQN_SUPABASE_EXPECTED_HOST \
    SUPABASE_SECRET_KEY \
    DASHSCOPE_API_KEY \
    WQN_ESP32_AI_PUBLIC_BASE_URL \
    WQN_ESP32_AI_AUDIO_URL_SECRET \
    STEP_API_KEY \
    WQN_REALTIME_PROXY_SECRET \
    WQN_INTERNAL_API_BASE \
    WQN_INTERNAL_API_ALLOWED_HOST
fi

ACR_SERVER="$(getv ACR_SERVER)"
ACR_NAMESPACE="$(getv ACR_NAMESPACE)"
ACR_REPO="$(getv ACR_REPO)"
ACR_USERNAME="$(getv ACR_USERNAME)"
ACR_PASSWORD="$(getv ACR_PASSWORD)"

if [[ -z "$APP_TAG" ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  [[ -n "$GIT_SHA" ]] || GIT_SHA="nogit"
  APP_TAG="${STAMP}-${GIT_SHA}"
fi
[[ -n "$RT_TAG" ]] || RT_TAG="${APP_TAG}-rt"

APP_IMAGE="${ACR_SERVER}/${ACR_NAMESPACE}/${ACR_REPO}:${APP_TAG}"
RT_IMAGE="${ACR_SERVER}/${ACR_NAMESPACE}/${RT_REPO}:${RT_TAG}"

# Explicit build proxy only. Ordinary HTTP_PROXY/HTTPS_PROXY are intentionally
# ignored so stale shell/system proxy settings cannot hijack a release.
BUILD_PROXY="$(getv WQN_BUILD_PROXY)"
BUILD_NO_PROXY="$(getv WQN_BUILD_NO_PROXY)"
if [[ -n "$BUILD_PROXY" && -z "$BUILD_NO_PROXY" ]]; then
  BUILD_NO_PROXY="localhost,127.0.0.1,::1"
fi

# Ensure this orchestrator itself does not inherit stale generic proxy vars.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
      http_proxy https_proxy all_proxy no_proxy || true

builder_proxy_url() {
  local p="$1"
  [[ -n "$p" ]] || return 0
  p="${p/\/\/127.0.0.1:/\/\/host.docker.internal:}"
  p="${p/\/\/localhost:/\/\/host.docker.internal:}"
  printf '%s' "$p"
}

BUILDER_PROXY="$(builder_proxy_url "$BUILD_PROXY")"

builder_fingerprint() {
  local config_hash="none"
  if [[ -f "$BUILDKIT_CONFIG" ]]; then
    config_hash="$(sha256sum "$BUILDKIT_CONFIG" | awk '{print $1}')"
  fi
  printf '%s\n' "config=$config_hash" "proxy=$BUILDER_PROXY" "no_proxy=$BUILD_NO_PROXY" |
    sha256sum | awk '{print $1}'
}

ensure_builder() {
  local name="$1" hash_file="$2"
  local expected recorded=""
  expected="$(builder_fingerprint)"
  [[ -f "$hash_file" ]] && recorded="$(tr -d '\r\n' < "$hash_file")"

  if docker buildx inspect "$name" >/dev/null 2>&1; then
    if (( RECREATE_BUILDERS )) || [[ "$recorded" != "$expected" ]]; then
      step "Recreating Buildx builder: $name"
      docker buildx rm --force "$name" >/dev/null
    fi
  fi

  if ! docker buildx inspect "$name" >/dev/null 2>&1; then
    step "Creating Buildx builder: $name"
    local args=(buildx create --name "$name" --driver docker-container)

    if [[ -n "$BUILDER_PROXY" ]]; then
      args+=(
        --driver-opt "env.HTTP_PROXY=$BUILDER_PROXY"
        --driver-opt "env.HTTPS_PROXY=$BUILDER_PROXY"
        --driver-opt "env.http_proxy=$BUILDER_PROXY"
        --driver-opt "env.https_proxy=$BUILDER_PROXY"
      )
      if [[ -n "$BUILD_NO_PROXY" ]]; then
        args+=(
          --driver-opt "env.NO_PROXY=$BUILD_NO_PROXY"
          --driver-opt "env.no_proxy=$BUILD_NO_PROXY"
        )
      fi
    fi

    [[ -f "$BUILDKIT_CONFIG" ]] && args+=(--config "$BUILDKIT_CONFIG")
    docker "${args[@]}" >/dev/null
  fi

  step "Bootstrapping Buildx builder: $name"
  docker buildx inspect "$name" --bootstrap >/dev/null
  printf '%s' "$expected" > "$hash_file"
}

append_build_arg_if_set() {
  local array_name="$1" key="$2" value
  value="$(getv "$key")"
  [[ -n "$value" ]] || return 0
  local -n out="$array_name"
  out+=(--build-arg "${key}=${value}")
}

append_proxy_build_args() {
  local array_name="$1"
  local -n out="$array_name"
  [[ -n "$BUILDER_PROXY" ]] || return 0
  out+=(
    --build-arg "HTTP_PROXY=$BUILDER_PROXY"
    --build-arg "HTTPS_PROXY=$BUILDER_PROXY"
    --build-arg "http_proxy=$BUILDER_PROXY"
    --build-arg "https_proxy=$BUILDER_PROXY"
  )
  if [[ -n "$BUILD_NO_PROXY" ]]; then
    out+=(
      --build-arg "NO_PROXY=$BUILD_NO_PROXY"
      --build-arg "no_proxy=$BUILD_NO_PROXY"
    )
  fi
}

build_app() {
  local args=(
    docker buildx build
    --builder "$APP_BUILDER"
    --platform linux/amd64
    --provenance=false
    --push
    -t "$APP_IMAGE"
    -f "$WEB_DIR/Dockerfile"
  )

  # Union of the build-time values used by the existing/current WQN scripts.
  local key
  for key in \
    BASE_NODE_IMAGE \
    NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY \
    WQN_SUPABASE_EXPECTED_HOST \
    SUPABASE_SERVICE_ROLE_KEY \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    GEMINI_API_KEY \
    SITE_URL
  do
    append_build_arg_if_set args "$key"
  done
  append_proxy_build_args args
  args+=(.)

  cd "$WEB_DIR"
  "${args[@]}"
}

build_realtime() {
  local args=(
    docker buildx build
    --builder "$RT_BUILDER"
    --platform linux/amd64
    --provenance=false
    --push
    -t "$RT_IMAGE"
    -f "$WEB_DIR/Dockerfile.realtime"
  )
  append_proxy_build_args args
  args+=(.)

  cd "$WEB_DIR"
  "${args[@]}"
}

# Runtime env allow-list. Extra optional keys are included only when present.
RUNTIME_KEYS=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
  WQN_SUPABASE_EXPECTED_HOST
  SUPABASE_SECRET_KEY
  SUPABASE_SERVICE_ROLE_KEY
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  NEXT_PUBLIC_APP_URL
  SITE_URL
  CRON_SECRET
  AI_PROVIDER
  AI_PROVIDER_BASE_URL
  AI_PROVIDER_API_KEY
  GEMINI_API_KEY
  ANTHROPIC_API_KEY
  AI_MODEL_EXTRACTION
  AI_MODEL_CATEGORISATION
  AI_MODEL_DIGEST
  WQN_ESP32_AI_ASR_PROVIDER
  WQN_ESP32_AI_ASR_FALLBACK_PROVIDER
  WQN_ESP32_AI_CHAT_PROVIDER
  DASHSCOPE_API_KEY
  DASHSCOPE_CHAT_API_KEY
  DASHSCOPE_CHAT_API_KEY_STD
  DASHSCOPE_CHAT_API_KEY_PRO
  DASHSCOPE_OPENAI_BASE_URL
  DASHSCOPE_OPENAI_BASE_URL_STD
  DASHSCOPE_OPENAI_BASE_URL_PRO
  DASHSCOPE_ASR_MODEL
  DASHSCOPE_ASR_TASK_URL
  DASHSCOPE_TASK_STATUS_BASE_URL
  DASHSCOPE_ASR_LANGUAGE_HINTS
  DASHSCOPE_ASR_POLL_INTERVAL_MS
  DASHSCOPE_ASR_POLL_ATTEMPTS
  DASHSCOPE_CHAT_MODEL
  DASHSCOPE_CHAT_MODEL_STD
  DASHSCOPE_CHAT_MODEL_PRO
  STEP_API_KEY
  STEPFUN_API_KEY
  STEPFUN_ASR_URL
  STEPFUN_ASR_MODEL
  STEPFUN_ASR_LANGUAGE
  STEPFUN_ASR_HOTWORDS
  STEPFUN_ASR_ENABLE_ITN
  WQN_ESP32_AI_SYSTEM_PROMPT
  WQN_ESP32_AI_PUBLIC_BASE_URL
  WQN_ESP32_AI_AUDIO_URL_SECRET
  WQN_ESP32_AI_AUDIO_TMP_DIR
  WQN_ESP32_AI_AUDIO_URL_TTL_MS
  WQN_ESP32_AI_PROVIDER_TIMEOUT_MS
  WQN_ESP32_AI_LLM_TIMEOUT_MS
  WQN_ESP32_AI_ASR_TIMEOUT_MS
  WQN_ESP32_AI_STREAM_EVENT_ID_BASE
  WQN_REALTIME_PROXY_SECRET
  WQN_INTERNAL_API_BASE
  WQN_INTERNAL_API_ALLOWED_HOST
  SENTRY_DSN
)

make_runtime_env() {
  local out="$1" key value
  : > "$out"
  chmod 600 "$out"
  for key in "${RUNTIME_KEYS[@]}"; do
    value="$(getv "$key")"
    [[ -n "$value" ]] || continue
    value="${value//$'\r'/}"
    value="${value//$'\n'/}"
    printf '%s=%s\n' "$key" "$value" >> "$out"
  done
}

deploy_all() {
  local tmp_env env_b64
  tmp_env="$(mktemp)"
  make_runtime_env "$tmp_env"
  env_b64="$(base64 -w0 "$tmp_env")"
  rm -f "$tmp_env"

  step "Deploying to ECS: $SSH_HOST"

  ssh "$SSH_HOST" bash -s -- \
    "$APP_IMAGE" \
    "$RT_IMAGE" \
    "$SKIP_REALTIME" \
    "$APP_CONTAINER" \
    "$APP_PORT" \
    "$RT_CONTAINER" \
    "$RT_PORT" \
    "$RUNTIME_NETWORK" \
    "$REMOTE_ENV_FILE" \
    "$env_b64" <<'REMOTE'
set -Eeuo pipefail

APP_IMAGE="$1"
RT_IMAGE="$2"
SKIP_REALTIME="$3"
APP_CONTAINER="$4"
APP_PORT="$5"
RT_CONTAINER="$6"
RT_PORT="$7"
NETWORK="$8"
REMOTE_ENV="$9"
ENV_B64="${10}"

if [[ "$REMOTE_ENV" = /* ]]; then
  ENV_FILE="$REMOTE_ENV"
else
  ENV_FILE="$HOME/$REMOTE_ENV"
fi

printf '%s\n' '[deploy] Updating runtime env...'
mkdir -p "$(dirname "$ENV_FILE")"
umask 077
printf '%s' "$ENV_B64" | base64 -d > "$ENV_FILE"

printf '%s\n' '[deploy] Pulling release images before switching containers...'
docker pull "$APP_IMAGE" &
PULL_APP=$!

if (( ! SKIP_REALTIME )); then
  docker pull "$RT_IMAGE" &
  PULL_RT=$!
else
  PULL_RT=''
fi

set +e
wait "$PULL_APP"
APP_PULL_RC=$?
if [[ -n "$PULL_RT" ]]; then
  wait "$PULL_RT"
  RT_PULL_RC=$?
else
  RT_PULL_RC=0
fi
set -e

if (( APP_PULL_RC != 0 || RT_PULL_RC != 0 )); then
  printf '%s\n' "[deploy] Pull failed: app=$APP_PULL_RC realtime=$RT_PULL_RC" >&2
  printf '%s\n' '[deploy] Existing containers were NOT touched.' >&2
  exit 1
fi

printf '%s\n' '[deploy] Ensuring private runtime network...'
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

printf '%s\n' '[deploy] Replacing app container...'
docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true
docker rm "$APP_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$APP_CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --network-alias wqn \
  --env-file "$ENV_FILE" \
  -p "$APP_PORT" \
  "$APP_IMAGE"

if (( ! SKIP_REALTIME )); then
  printf '%s\n' '[deploy] Replacing realtime container...'
  docker stop "$RT_CONTAINER" >/dev/null 2>&1 || true
  docker rm "$RT_CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$RT_CONTAINER" \
    --restart unless-stopped \
    --network "$NETWORK" \
    --env-file "$ENV_FILE" \
    -p "$RT_PORT" \
    "$RT_IMAGE"

  printf '%s\n' '[deploy] Checking realtime health...'
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if (( ! ok )); then
    printf '%s\n' '[deploy] WARNING: realtime health endpoint did not become ready in 10s.' >&2
    docker logs --tail 80 "$RT_CONTAINER" >&2 || true
    exit 1
  fi
fi

printf '%s\n' '[deploy] Pruning unused images...'
docker image prune -f >/dev/null
printf '%s\n' '[deploy] WQN deploy complete.'
REMOTE
}

printf '\n========================================\n'
printf ' WQN WSL Release\n'
printf '========================================\n'
printf 'Project:        %s\n' "$PROJECT_ROOT"
printf 'App tag:        %s\n' "$APP_TAG"
printf 'Realtime tag:   %s\n' "$RT_TAG"
printf 'App image:      %s\n' "$APP_IMAGE"
if (( ! SKIP_REALTIME )); then
  printf 'Realtime image: %s\n' "$RT_IMAGE"
fi
if [[ -n "$BUILD_PROXY" ]]; then
  printf 'Build proxy:    %s\n' "$BUILD_PROXY"
else
  printf 'Build proxy:    direct (Docker Desktop -> F50P/OpenClash)\n'
fi
if (( NO_DEPLOY )); then
  printf 'Deploy:         disabled\n'
else
  printf 'Deploy:         %s\n' "$SSH_HOST"
fi
printf '========================================\n'

step "Checking Docker Desktop / Buildx"
if ! docker info >/dev/null 2>&1; then
  cat >&2 <<'ERR'
ERROR: Docker daemon is unavailable from this WSL distro.
Enable Docker Desktop -> Settings -> Resources -> WSL Integration for Ubuntu,
Apply/Restart Docker Desktop, then retry.
ERR
  exit 1
fi
docker buildx version >/dev/null

step "Logging into ACR"
printf '%s\n' "$ACR_PASSWORD" |
  docker login "$ACR_SERVER" --username "$ACR_USERNAME" --password-stdin

# Initialize builders before parallel build output begins. This also recreates
# old builders once when their old proxy/config fingerprint differs.
ensure_builder "$APP_BUILDER" "$APP_BUILDER_HASH_FILE"
if (( ! SKIP_REALTIME )); then
  ensure_builder "$RT_BUILDER" "$RT_BUILDER_HASH_FILE"
fi

step "Starting parallel build + push"
(
  set -o pipefail
  build_app 2>&1 | sed -u 's/^/[APP] /'
) &
APP_PID=$!

if (( ! SKIP_REALTIME )); then
  (
    set -o pipefail
    build_realtime 2>&1 | sed -u 's/^/[RT ] /'
  ) &
  RT_PID=$!
else
  RT_PID=""
fi

set +e
wait "$APP_PID"
APP_RC=$?
if [[ -n "$RT_PID" ]]; then
  wait "$RT_PID"
  RT_RC=$?
else
  RT_RC=0
fi
set -e

printf '\nBuild results: app=%d realtime=%d\n' "$APP_RC" "$RT_RC"
if (( APP_RC != 0 || RT_RC != 0 )); then
  echo "ERROR: build phase failed; nothing will be deployed." >&2
  exit 1
fi

step "Both requested images were built and pushed"

if (( NO_DEPLOY )); then
  echo "Release stopped after push (--no-deploy)."
  exit 0
fi

deploy_all

printf '\n========================================\n'
printf ' WQN release complete\n'
printf ' App:      %s\n' "$APP_IMAGE"
if (( ! SKIP_REALTIME )); then
  printf ' Realtime: %s\n' "$RT_IMAGE"
fi
printf '========================================\n'
