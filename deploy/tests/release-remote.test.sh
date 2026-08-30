#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/state"
cat > "$TMP_DIR/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -u
log_line='docker'
for arg in "$@"; do log_line+=" <$arg>"; done
printf '%s\n' "$log_line" >> "$WQN_MOCK_DOCKER_LOG"

command_name="${1:-}"
shift || true
case "$command_name" in
  pull)
    [[ "${1:-}" != "${WQN_FAIL_PULL_IMAGE:-}" ]]
    ;;
  network)
    exit 0
    ;;
  stop|rm|logs)
    exit 0
    ;;
  run)
    container=''
    env_file=''
    while (($#)); do
      case "$1" in
        --name) container="$2"; shift 2 ;;
        --env-file) env_file="$2"; shift 2 ;;
        --network|--network-alias|--restart|-p) shift 2 ;;
        -d) shift ;;
        *) shift ;;
      esac
    done
    cp "$env_file" "$WQN_MOCK_DOCKER_STATE/$container.env"
    printf 'mock-container-id\n'
    ;;
  exec)
    container="$1"
    shift
    if [[ "${1:-}" == wget ]]; then
      exit 0
    fi
    if [[ "${1:-}" == printenv ]]; then
      key="$2"
      line="$(grep -m1 "^${key}=" "$WQN_MOCK_DOCKER_STATE/$container.env")" || exit 1
      printf '%s\n' "${line#*=}"
      exit 0
    fi
    if [[ "${1:-}" == node ]]; then
      exit 0
    fi
    exit 1
    ;;
  image)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
MOCK
chmod +x "$TMP_DIR/bin/docker"

make_manifest() {
  local env_file="$1" out="$2" line key value hash
  : > "$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    hash="$(printf '%s' "$value" | sha256sum | awk '{print $1}')"
    printf '%s=%s\n' "$key" "$hash" >> "$out"
  done < "$env_file"
  chmod 600 "$out"
}

prepare_home() {
  local home_dir="$1" stage="$1/.wqn-release-stage.TEST123"
  mkdir -p "$stage"
  chmod 700 "$stage"
  cat > "$stage/app.env" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://data.example.test
SUPABASE_SECRET_KEY=new-server-key
SITE_URL=https://app.example.test
EOF
  cat > "$stage/realtime.env" <<'EOF'
SUPABASE_URL=https://data.example.test
SUPABASE_SECRET_KEY=new-server-key
STEP_API_KEY=realtime-only-key
WQN_INTERNAL_API_BASE=http://wqn:3000
EOF
  chmod 600 "$stage/app.env" "$stage/realtime.env"
  make_manifest "$stage/app.env" "$stage/app.sha256"
  make_manifest "$stage/realtime.env" "$stage/realtime.sha256"
  printf '%s\n' ACR_PASSWORD SUPABASE_URL NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    > "$stage/app.forbidden"
  printf '%s\n' ACR_PASSWORD NEXT_PUBLIC_SUPABASE_URL AI_PROVIDER_API_KEY \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY > "$stage/realtime.forbidden"
  chmod 600 "$stage/app.forbidden" "$stage/realtime.forbidden"
  printf '%s\n' 'OLD_APP=1' > "$home_dir/.env.wqn-app"
  printf '%s\n' 'OLD_RT=1' > "$home_dir/.env.wqn-realtime"
  printf '%s\n' 'NEXT_PUBLIC_SUPABASE_URL=https://old-ref.supabase.co' \
    > "$home_dir/.env.production"
  chmod 600 "$home_dir/.env.wqn-app" "$home_dir/.env.wqn-realtime" \
    "$home_dir/.env.production"
}

SUCCESS_HOME="$TMP_DIR/success-home"
mkdir -p "$SUCCESS_HOME"
prepare_home "$SUCCESS_HOME"
export PATH="$TMP_DIR/bin:$PATH"
export WQN_MOCK_DOCKER_LOG="$TMP_DIR/docker-success.log"
export WQN_MOCK_DOCKER_STATE="$TMP_DIR/state"
unset WQN_FAIL_PULL_IMAGE || true

HOME="$SUCCESS_HOME" bash "$DEPLOY_DIR/release-remote.sh" \
  app:image rt:image 0 wqn-app 3000:3000 wqn-realtime \
  127.0.0.1:8080:8080 wqn-runtime .env.wqn-app \
  "$SUCCESS_HOME/.wqn-release-stage.TEST123" > "$TMP_DIR/success.output"

grep -Fq 'NEXT_PUBLIC_SUPABASE_URL=https://data.example.test' \
  "$SUCCESS_HOME/.env.wqn-app"
grep -Fq 'STEP_API_KEY=realtime-only-key' "$SUCCESS_HOME/.env.wqn-realtime"
[[ "$(stat -c '%a' "$SUCCESS_HOME/.env.wqn-app")" == 600 ]]
[[ "$(stat -c '%a' "$SUCCESS_HOME/.env.wqn-realtime")" == 600 ]]
[[ ! -e "$SUCCESS_HOME/.env.production" ]]
find "$SUCCESS_HOME" -maxdepth 1 -name '.env.production.retired-*' \
  -type f | grep -q .
BACKUP_DIR="$(find "$SUCCESS_HOME/.wqn-env-backups" -mindepth 1 -maxdepth 1 -type d | head -n1)"
grep -Fq 'OLD_APP=1' "$BACKUP_DIR/app.env"
grep -Fq 'OLD_RT=1' "$BACKUP_DIR/realtime.env"
grep -Fq 'old-ref.supabase.co' "$BACKUP_DIR/legacy.env.production"
grep -Fq 'Legacy Supabase Cloud config detected and retired' "$TMP_DIR/success.output"
grep -Fq 'env hash verification passed' "$TMP_DIR/success.output"

PULL_LAST="$(grep -n '^docker <pull>' "$WQN_MOCK_DOCKER_LOG" | tail -n1 | cut -d: -f1)"
STOP_FIRST="$(grep -n '^docker <stop>' "$WQN_MOCK_DOCKER_LOG" | head -n1 | cut -d: -f1)"
(( PULL_LAST < STOP_FIRST ))

FAIL_HOME="$TMP_DIR/fail-home"
mkdir -p "$FAIL_HOME"
prepare_home "$FAIL_HOME"
export WQN_MOCK_DOCKER_LOG="$TMP_DIR/docker-fail.log"
export WQN_FAIL_PULL_IMAGE='rt:image'
if HOME="$FAIL_HOME" bash "$DEPLOY_DIR/release-remote.sh" \
    app:image rt:image 0 wqn-app 3000:3000 wqn-realtime \
    127.0.0.1:8080:8080 wqn-runtime .env.wqn-app \
    "$FAIL_HOME/.wqn-release-stage.TEST123" > "$TMP_DIR/fail.output" 2>&1; then
  printf '%s\n' 'FAIL: remote release accepted a failed image pull' >&2
  exit 1
fi
grep -Fq 'OLD_APP=1' "$FAIL_HOME/.env.wqn-app"
grep -Fq 'OLD_RT=1' "$FAIL_HOME/.env.wqn-realtime"
grep -Fq 'old-ref.supabase.co' "$FAIL_HOME/.env.production"
if grep -q '^docker <stop>' "$WQN_MOCK_DOCKER_LOG"; then
  printf '%s\n' 'FAIL: a container was touched after pull failure' >&2
  exit 1
fi

printf '%s\n' 'PASS: remote env backup, atomic split, pull gate, and hash audit'
