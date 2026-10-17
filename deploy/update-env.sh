#!/usr/bin/env bash
# WQN: sync the local App runtime env to Aliyun and recreate ONLY wqn-app.
# Does not build/pull images or restart wqn-realtime.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ENV="$REPO_ROOT/web/.env.production"
POLICY="$SCRIPT_DIR/release-env-policy.sh"
SSH_HOST="${WQN_ENV_SSH_HOST:-aliyun}"
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --check) DRY_RUN=1 ;;
  -h|--help)
    echo "Usage: bash deploy/update-env.sh [--check]"
    echo "  --check  Validate locally without uploading/restarting anything."
    exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

for program in bash python3 ssh scp mktemp; do
  command -v "$program" >/dev/null 2>&1 || { echo "Missing command: $program" >&2; exit 1; }
done
[[ -f "$SOURCE_ENV" ]] || { echo "Missing file: $SOURCE_ENV" >&2; exit 1; }
[[ -f "$POLICY" ]] || { echo "Missing file: $POLICY" >&2; exit 1; }

# This is source code maintained in this repo, NOT the contents of .env.production.
# shellcheck source=deploy/release-env-policy.sh
source "$POLICY"

LOCAL_STAGE="$(mktemp -d)"
chmod 700 "$LOCAL_STAGE"
REMOTE_STAGE=""
cleanup() {
  rm -rf -- "$LOCAL_STAGE"
  if [[ -n "$REMOTE_STAGE" ]]; then
    ssh -o BatchMode=yes "$SSH_HOST" "rm -rf -- '$REMOTE_STAGE'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Reuse the project's App allowlist, with Web Push keys that the regular
# release policy has not yet been updated to pass through, plus the App's
# runtime streaming switches documented in the production env template.
{
  runtime_keys_for app
  printf '%s\n' \
    VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT \
    WQN_ESP32_AI_STREAMING_MODE WQN_ESP32_AI_STREAM_TIMEOUT_MS \
    WQN_ESP32_AI_STREAM_ASR_POLL_INTERVAL_MS \
    WQN_ESP32_AI_STREAM_MAX_TOOLS_PER_TURN \
    WQN_ESP32_AI_STREAM_REQUEST_CACHE_HOURS WQN_AI_STREAMING_ENABLED
} | sort -u > "$LOCAL_STAGE/allowed-keys"
printf '%s\n' "${APP_REQUIRED_RUNTIME_KEYS[@]}" > "$LOCAL_STAGE/required-keys"

# Parse .env.production AS DATA (never source/eval it), emit only App keys,
# and never print any value, hash, or secret.
python3 - "$SOURCE_ENV" "$LOCAL_STAGE/allowed-keys" "$LOCAL_STAGE/required-keys" "$LOCAL_STAGE/app.env" <<'PY'
import re
import sys
from pathlib import Path

source, allowed_file, required_file, output = map(Path, sys.argv[1:])
allowed = set(allowed_file.read_text().splitlines())
required = set(required_file.read_text().splitlines())
pattern = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
values = {}
for number, raw in enumerate(source.read_text(encoding='utf-8-sig').splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('export '):
        line = line[7:].strip()
    match = pattern.fullmatch(line)
    if match is None:
        raise SystemExit(f'ERROR: invalid .env.production line {number}; no files uploaded')
    key, value = match.groups()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1]
    if '\x00' in value or '\r' in value or '\n' in value:
        raise SystemExit(f'ERROR: invalid newline/NUL in {key}')
    values[key] = value

if values.get('SUPABASE_SERVICE_ROLE_KEY'):
    raise SystemExit('ERROR: legacy SUPABASE_SERVICE_ROLE_KEY is populated; use SUPABASE_SECRET_KEY')

placeholders = {
    'sb_publishable_replace_me', 'sb_secret_replace_me',
    'your_anon_key_here', 'your_service_role_key_here',
    'replace_with_long_random_secret', 'https://data.example.invalid',
    'https://your-domain.com',
}
missing = sorted(key for key in required if not values.get(key) or values[key] in placeholders)
if missing:
    raise SystemExit('ERROR: required App variables missing/placeholders:\n  ' + '\n  '.join(missing))

app_values = {key: value for key, value in values.items() if key in allowed and value}
output.write_text(''.join(f'{key}={value}\n' for key, value in sorted(app_values.items())), encoding='utf-8')
output.chmod(0o600)

print(f'Validated {len(app_values)} App environment variables.')
print('Web Push:', ', '.join(f'{key}={"SET" if values.get(key) else "UNSET"}' for key in (
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT')))
print('Excluded from upload: ACR credentials, database maintenance URL, Realtime-only credentials, build-only secrets.')
PY

if (( DRY_RUN )); then
  echo '[check] Local App env validation passed; cloud was NOT changed.'
  exit 0
fi

cat <<'MSG'

This will RECREATE the running Aliyun wqn-app container using its CURRENT image.
The site may be briefly unavailable. wqn-realtime and the database are untouched.
This changes server-side runtime env; it CANNOT replace values baked into a Next.js client bundle.
MSG
read -r -p "Proceed with Aliyun App env update? Type YES: " confirmation
[[ "$confirmation" == YES ]] || { echo 'Cancelled; nothing changed.'; exit 0; }

# Stage only sanitized App env; never copy the entire .env.production file.
REMOTE_STAGE="$(ssh -o BatchMode=yes "$SSH_HOST" \
  'umask 077; mktemp -d "$HOME/.wqn-env-update.XXXXXX"')"
if [[ ! "$REMOTE_STAGE" =~ ^/root/\.wqn-env-update\.[A-Za-z0-9]+$ ]]; then
  echo 'ERROR: remote temporary directory validation failed' >&2
  exit 1
fi
scp -q -o BatchMode=yes "$LOCAL_STAGE/app.env" "$SSH_HOST:$REMOTE_STAGE/app.env"

ssh -o BatchMode=yes -T "$SSH_HOST" bash -s -- "$REMOTE_STAGE" <<'REMOTE_BASH'
#!/usr/bin/env bash
set -Eeuo pipefail

STAGE="${1:?missing stage}"
APP=wqn-app
TARGET=/root/.env.wqn-app
NEW_ENV="$STAGE/app.env"
[[ "$STAGE" =~ ^/root/\.wqn-env-update\.[A-Za-z0-9]+$ ]] || exit 1
[[ -s "$NEW_ENV" ]] || { echo 'ERROR: missing staged App env' >&2; exit 1; }
chmod 600 "$NEW_ENV"
command -v docker >/dev/null || { echo 'ERROR: docker not installed' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'ERROR: python3 not installed' >&2; exit 1; }
command -v curl >/dev/null || { echo 'ERROR: curl not installed' >&2; exit 1; }

# Fail closed if container topology changed since the user's last inspection.
# In that case the script must not silently drop mounts, ports or network settings.
docker inspect "$APP" | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
h = c["HostConfig"]
p = h["PortBindings"] or {}
port = p.get("3000/tcp", [])
checks = {
    "private Docker network wqn-runtime": h["NetworkMode"] == "wqn-runtime",
    "only host port 3000 -> container port 3000": len(p) == 1 and len(port) == 1 and port[0]["HostPort"] == "3000" and port[0]["HostIp"] in ("", "0.0.0.0"),
    "no bind mounts or Docker volumes": not c["Mounts"],
    "restart policy unless-stopped": h["RestartPolicy"]["Name"] == "unless-stopped",
    "existing App running": c["State"]["Running"] is True,
}
for description, ok in checks.items():
    if not ok:
        print("ERROR: unexpected container topology: " + description, file=sys.stderr)
if not all(checks.values()):
    sys.exit(1)
'

IMAGE="$(docker inspect -f '{{.Config.Image}}' "$APP")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="/root/.wqn-env-backups/$STAMP"
OLD_CONTAINER="wqn-app.env-backup-$STAMP"
install -d -m 700 "$BACKUP_DIR"
PREVIOUS_ENV_EXISTED=0
if [[ -f "$TARGET" ]]; then
  cp -p "$TARGET" "$BACKUP_DIR/app.env"
  chmod 600 "$BACKUP_DIR/app.env"
  PREVIOUS_ENV_EXISTED=1
fi

ENV_INSTALLED=0
OLD_STOPPED=0
OLD_RENAMED=0
on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo '[update-env] Failed. Attempting automatic rollback...' >&2
    # docker run can fail *after* creating the name but before returning a
    # successful container ID. Remove any partial new container before rename.
    if (( OLD_RENAMED )); then
      docker rm -f "$APP" >/dev/null 2>&1 || true
      docker rename "$OLD_CONTAINER" "$APP" >/dev/null 2>&1 || true
      docker start "$APP" >/dev/null 2>&1 || true
    elif (( OLD_STOPPED )); then
      docker start "$APP" >/dev/null 2>&1 || true
    fi
    if (( ENV_INSTALLED )); then
      if (( PREVIOUS_ENV_EXISTED )); then
        cp -p "$BACKUP_DIR/app.env" "$TARGET" || true
        chmod 600 "$TARGET" || true
      else
        rm -f -- "$TARGET" || true
      fi
    fi
    echo "[update-env] Previous App restart attempted. Env backup: $BACKUP_DIR" >&2
  fi
  rm -rf -- "$STAGE"
  exit "$status"
}
trap on_exit EXIT

# Install atomically, preserving the old env backup.
umask 077
TEMP="$(mktemp /root/.wqn-app.tmp.XXXXXX)"
cp "$NEW_ENV" "$TEMP"
chmod 600 "$TEMP"
mv -f -- "$TEMP" "$TARGET"
ENV_INSTALLED=1

echo "[update-env] Recreating $APP with existing image: $IMAGE"
docker stop -t 15 "$APP" >/dev/null
OLD_STOPPED=1
docker rename "$APP" "$OLD_CONTAINER"
OLD_RENAMED=1

docker run -d \
  --name "$APP" \
  --restart unless-stopped \
  --network wqn-runtime \
  --network-alias wqn \
  --env-file "$TARGET" \
  -p 3000:3000 \
  "$IMAGE" >/dev/null

# A 2xx/3xx response from the App HTTP root indicates it booted successfully.
OK=0
for attempt in $(seq 1 20); do
  status_code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || true)"
  if [[ "$status_code" =~ ^[23][0-9][0-9]$ ]]; then
    OK=1
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null || echo false)" != true ]]; then
    break
  fi
  sleep 2
done
(( OK )) || { echo 'ERROR: App HTTP readiness check failed' >&2; exit 1; }

# New container is verified; remove the stopped fallback container.
docker rm "$OLD_CONTAINER" >/dev/null
OLD_RENAMED=0

echo '[update-env] SUCCESS: wqn-app restarted with the new App env.'
echo "[update-env] Env saved: $TARGET"
echo "[update-env] Env backup: $BACKUP_DIR"
for key in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT; do
  if docker exec "$APP" printenv "$key" >/dev/null 2>&1; then
    echo "[update-env] $key: SET"
  else
    echo "[update-env] $key: UNSET"
  fi
done
REMOTE_BASH

REMOTE_STAGE=""
echo 'Finished. Reminder: regular deploy/release.sh may replace the App env based on its own allowlist.'
