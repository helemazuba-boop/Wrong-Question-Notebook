#!/usr/bin/env bash
set -Eeuo pipefail

# Executed by release.sh over SSH. Secret env files arrive through scp in a
# freshly-created 0700 staging directory; no secret is put in an SSH argv.

APP_IMAGE="$1"
RT_IMAGE="$2"
SKIP_REALTIME="$3"
APP_CONTAINER="$4"
APP_PORT="$5"
RT_CONTAINER="$6"
RT_PORT="$7"
NETWORK="$8"
REMOTE_APP_ENV="$9"
STAGE_DIR="${10}"

if [[ "$REMOTE_APP_ENV" = /* ]]; then
  APP_ENV_FILE="$REMOTE_APP_ENV"
else
  APP_ENV_FILE="$HOME/$REMOTE_APP_ENV"
fi
RT_ENV_FILE="$HOME/.env.wqn-realtime"
LEGACY_ENV_FILE="$HOME/.env.production"

case "$STAGE_DIR" in
  "$HOME"/.wqn-release-stage.*) ;;
  *)
    printf '%s\n' '[deploy] Invalid release staging directory.' >&2
    exit 1
    ;;
esac
if [[ "$APP_ENV_FILE" == "$LEGACY_ENV_FILE" ]]; then
  printf '%s\n' '[deploy] Refusing to use legacy ~/.env.production as the App runtime env.' >&2
  exit 1
fi
if [[ "$APP_ENV_FILE" == "$RT_ENV_FILE" ]]; then
  printf '%s\n' '[deploy] App and Realtime must not share a runtime env file.' >&2
  exit 1
fi

cleanup() {
  rm -rf -- "$STAGE_DIR"
}
trap cleanup EXIT

APP_STAGE="$STAGE_DIR/app.env"
APP_HASH_STAGE="$STAGE_DIR/app.sha256"
APP_FORBIDDEN_STAGE="$STAGE_DIR/app.forbidden"
RT_STAGE="$STAGE_DIR/realtime.env"
RT_HASH_STAGE="$STAGE_DIR/realtime.sha256"
RT_FORBIDDEN_STAGE="$STAGE_DIR/realtime.forbidden"

for required_file in "$APP_STAGE" "$APP_HASH_STAGE" "$APP_FORBIDDEN_STAGE"; do
  [[ -f "$required_file" ]] || {
    printf '[deploy] Missing staged file: %s\n' "$(basename "$required_file")" >&2
    exit 1
  }
done
if (( ! SKIP_REALTIME )); then
  for required_file in "$RT_STAGE" "$RT_HASH_STAGE" "$RT_FORBIDDEN_STAGE"; do
    [[ -f "$required_file" ]] || {
      printf '[deploy] Missing staged file: %s\n' "$(basename "$required_file")" >&2
      exit 1
    }
  done
fi
chmod 600 "$APP_STAGE" "$APP_HASH_STAGE" "$APP_FORBIDDEN_STAGE"
if (( ! SKIP_REALTIME )); then
  chmod 600 "$RT_STAGE" "$RT_HASH_STAGE" "$RT_FORBIDDEN_STAGE"
fi

printf '%s\n' '[deploy] Pulling all requested release images before changing env or containers...'
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
  printf '[deploy] Pull failed: app=%s realtime=%s\n' "$APP_PULL_RC" "$RT_PULL_RC" >&2
  printf '%s\n' '[deploy] Existing env files and containers were NOT touched.' >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$HOME/.wqn-env-backups/$STAMP"
install -d -m 700 "$BACKUP_DIR"

backup_env() {
  local source="$1" label="$2"
  [[ -f "$source" ]] || return 0
  cp -- "$source" "$BACKUP_DIR/$label"
  chmod 600 "$BACKUP_DIR/$label"
}

printf '%s\n' '[deploy] Backing up existing remote env files...'
backup_env "$APP_ENV_FILE" app.env
if (( ! SKIP_REALTIME )); then
  backup_env "$RT_ENV_FILE" realtime.env
fi
if [[ "$LEGACY_ENV_FILE" != "$APP_ENV_FILE" ]]; then
  backup_env "$LEGACY_ENV_FILE" legacy.env.production
fi

atomic_install_env() {
  local source="$1" target="$2" target_dir temp
  target_dir="$(dirname "$target")"
  if [[ ! -d "$target_dir" ]]; then
    install -d -m 700 "$target_dir"
  fi
  umask 077
  temp="$(mktemp "$target_dir/.wqn-env.tmp.XXXXXX")"
  cp -- "$source" "$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$target"
}

printf '%s\n' '[deploy] Atomically installing least-privilege runtime env files...'
atomic_install_env "$APP_STAGE" "$APP_ENV_FILE"
if (( ! SKIP_REALTIME )); then
  atomic_install_env "$RT_STAGE" "$RT_ENV_FILE"
fi

# The former deployment path used /root/.env.production for both services.
# Archive it after the new App env has landed so no later deploy can silently
# consume residual Supabase Cloud values from that legacy path.
if [[ -f "$LEGACY_ENV_FILE" && "$LEGACY_ENV_FILE" != "$APP_ENV_FILE" ]]; then
  if grep -E "^[[:space:]]*(export[[:space:]]+)?(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL)[[:space:]]*=[[:space:]]*[\"']?https://[^[:space:]\"']*\.supabase\.co([/:\"']|$)" \
      "$LEGACY_ENV_FILE" >/dev/null 2>&1; then
    printf '%s\n' '[deploy] Legacy Supabase Cloud config detected and retired (values not printed).'
  else
    printf '%s\n' '[deploy] Retiring legacy ~/.env.production; future releases do not use it.'
  fi
  LEGACY_RETIRED="$HOME/.env.production.retired-$STAMP"
  chmod 600 "$LEGACY_ENV_FILE"
  mv -- "$LEGACY_ENV_FILE" "$LEGACY_RETIRED"
fi

printf '[deploy] Env backup: %s\n' "$BACKUP_DIR"

printf '%s\n' '[deploy] Ensuring private runtime network...'
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

printf '%s\n' '[deploy] Replacing App container...'
docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true
docker rm "$APP_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$APP_CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --network-alias wqn \
  --env-file "$APP_ENV_FILE" \
  -p "$APP_PORT" \
  "$APP_IMAGE"

if (( ! SKIP_REALTIME )); then
  printf '%s\n' '[deploy] Replacing Realtime container with its dedicated env...'
  docker stop "$RT_CONTAINER" >/dev/null 2>&1 || true
  docker rm "$RT_CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$RT_CONTAINER" \
    --restart unless-stopped \
    --network "$NETWORK" \
    --env-file "$RT_ENV_FILE" \
    -p "$RT_PORT" \
    "$RT_IMAGE"

  printf '%s\n' '[deploy] Checking Realtime health...'
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if docker exec "$RT_CONTAINER" wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if (( ! ok )); then
    printf '%s\n' '[deploy] Realtime health endpoint did not become ready in 10s.' >&2
    docker logs --tail 80 "$RT_CONTAINER" >&2 || true
    exit 1
  fi
fi

verify_container_hashes() {
  local component="$1" container="$2" manifest="$3"
  local line key expected actual actual_hash verified=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    key="${line%%=*}"
    expected="${line#*=}"
    if ! actual="$(docker exec "$container" printenv "$key")"; then
      printf '[deploy] %s is missing required env key %s.\n' "$component" "$key" >&2
      return 1
    fi
    actual_hash="$(printf '%s' "$actual" | sha256sum | awk '{print $1}')"
    if [[ "$actual_hash" != "$expected" ]]; then
      printf '[deploy] %s env hash mismatch for %s.\n' "$component" "$key" >&2
      return 1
    fi
    verified=$((verified + 1))
  done < "$manifest"
  printf '[deploy] %s env hash verification passed (%s keys; no values printed).\n' \
    "$component" "$verified"
}

verify_forbidden_absent() {
  local component="$1" container="$2" forbidden_file="$3"
  local key
  while IFS= read -r key || [[ -n "$key" ]]; do
    [[ -n "$key" ]] || continue
    if docker exec "$container" printenv "$key" >/dev/null 2>&1; then
      printf '[deploy] %s unexpectedly contains forbidden env key %s.\n' \
        "$component" "$key" >&2
      return 1
    fi
  done < "$forbidden_file"
}

printf '%s\n' '[deploy] Verifying actual container env without printing secrets...'
verify_container_hashes App "$APP_CONTAINER" "$APP_HASH_STAGE"
verify_forbidden_absent App "$APP_CONTAINER" "$APP_FORBIDDEN_STAGE"
if (( ! SKIP_REALTIME )); then
  verify_container_hashes Realtime "$RT_CONTAINER" "$RT_HASH_STAGE"
  verify_forbidden_absent Realtime "$RT_CONTAINER" "$RT_FORBIDDEN_STAGE"
fi

print_origins() {
  local component="$1" container="$2"
  shift 2
  docker exec "$container" node -e '
    const [component, ...keys] = process.argv.slice(1);
    for (const key of keys) {
      const raw = process.env[key];
      if (!raw) continue;
      let origin;
      try { origin = new URL(raw).origin; }
      catch { throw new Error(`${component} ${key} is not a valid URL`); }
      console.log(`[deploy] ${component} ${key} origin: ${origin}`);
    }
  ' "$component" "$@"
}

print_origins App "$APP_CONTAINER" NEXT_PUBLIC_SUPABASE_URL SITE_URL
if (( ! SKIP_REALTIME )); then
  print_origins Realtime "$RT_CONTAINER" SUPABASE_URL WQN_INTERNAL_API_BASE
fi

printf '%s\n' '[deploy] Pruning unused images...'
docker image prune -f >/dev/null
printf '%s\n' '[deploy] WQN deploy complete.'
