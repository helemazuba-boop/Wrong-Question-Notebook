#!/usr/bin/env bash
# ============================================================
# WQN production Supabase migration deploy
# ============================================================
# Preserves the original workflow and flags while targeting the explicit
# self-hosted production database from web/.env.production:
#   1. supabase --version
#   2. supabase migration list --db-url "$TARGET_DATABASE_URL"
#   3. supabase db push --db-url "$TARGET_DATABASE_URL" --dry-run
#   4. supabase db push --db-url "$TARGET_DATABASE_URL"
#      (skipped with --dry-run-only)
#
# PostgreSQL is never reached through data.helema.cn or a public DB socket.
# TARGET_DATABASE_URL must use a loopback host; this script opens an SSH
# localhost tunnel through the configured Tencent SSH alias for each run.
#
# USAGE:
#   ./deploy/supabase-push.sh                 # dry-run then apply
#   ./deploy/supabase-push.sh --include-all   # include-all migrations
#   ./deploy/supabase-push.sh --dry-run-only  # dry-run, do not apply
# ============================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/web"
ENV_FILE="$WEB_DIR/.env.production"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "ERROR: web dir not found: $WEB_DIR" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: production config not found: $ENV_FILE" >&2
  exit 1
fi

EXTRA_ARGS=()
DRY_RUN_ONLY=0
while (( $# )); do
  case "$1" in
    --include-all) EXTRA_ARGS+=(--include-all); shift ;;
    --dry-run-only) DRY_RUN_ONLY=1; shift ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

for command_name in python3 ssh supabase; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'ERROR: required command not found: %s\n' "$command_name" >&2
    exit 1
  }
done

# Dotenv is configuration data, not shell code. Only these maintenance keys
# are read; process environment variables cannot silently override them.
declare -A DOTENV=()
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  DOTENV["$key"]="$value"
done < <(
  python3 - "$ENV_FILE" <<'PY'
import re, sys

path = sys.argv[1]
wanted = {
    "TARGET_DATABASE_URL",
    "WQN_DATABASE_SSH_HOST",
    "WQN_DATABASE_SSH_TARGET",
}
pat = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$")
with open(path, encoding="utf-8-sig") as handle:
    for number, raw in enumerate(handle, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        match = pat.match(line)
        if not match:
            raise SystemExit(f"Invalid .env.production line {number}: {raw.rstrip()}")
        key, value = match.group(1), match.group(2).strip()
        if key not in wanted:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if "\r" in value or "\n" in value:
            raise SystemExit(f"Invalid newline in .env.production value: {key}")
        sys.stdout.buffer.write(key.encode() + b"\0" + value.encode() + b"\0")
PY
)

TARGET_DATABASE_URL="${DOTENV[TARGET_DATABASE_URL]:-}"
DATABASE_SSH_HOST="${DOTENV[WQN_DATABASE_SSH_HOST]:-tencent}"
DATABASE_SSH_TARGET="${DOTENV[WQN_DATABASE_SSH_TARGET]:-127.0.0.1:5432}"

if [[ -z "$TARGET_DATABASE_URL" ]]; then
  cat >&2 <<'ERR'
ERROR: TARGET_DATABASE_URL is missing from web/.env.production.
Set it to a percent-encoded PostgreSQL URL whose host is 127.0.0.1 or
localhost. release.sh never uploads this maintenance URL to App or Realtime.
ERR
  exit 1
fi
if [[ ! "$DATABASE_SSH_HOST" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  echo "ERROR: invalid WQN_DATABASE_SSH_HOST in web/.env.production" >&2
  exit 1
fi
if [[ ! "$DATABASE_SSH_TARGET" =~ ^([A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]):([0-9]{1,5})$ ]]; then
  echo "ERROR: WQN_DATABASE_SSH_TARGET must be HOST:PORT" >&2
  exit 1
fi
DATABASE_SSH_TARGET_HOST="${DATABASE_SSH_TARGET%:*}"
case "$DATABASE_SSH_TARGET_HOST" in
  127.0.0.1|localhost|'[::1]') ;;
  *)
    echo "ERROR: WQN_DATABASE_SSH_TARGET must use Tencent-host loopback, never a public PostgreSQL host" >&2
    exit 1
    ;;
esac
DATABASE_SSH_PORT="${DATABASE_SSH_TARGET##*:}"
if (( 10#$DATABASE_SSH_PORT < 1 || 10#$DATABASE_SSH_PORT > 65535 )); then
  echo "ERROR: WQN_DATABASE_SSH_TARGET port must be between 1 and 65535" >&2
  exit 1
fi

mapfile -d '' -t DB_ROUTE < <(
  python3 - "$TARGET_DATABASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit

raw = sys.argv[1]
try:
    value = urlsplit(raw)
    port = value.port or 5432
except ValueError as exc:
    raise SystemExit(f"ERROR: TARGET_DATABASE_URL is invalid: {exc}")
if value.scheme not in {"postgres", "postgresql"} or not value.hostname:
    raise SystemExit("ERROR: TARGET_DATABASE_URL must be a PostgreSQL URL")
host = value.hostname.lower()
if host not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit(
        "ERROR: TARGET_DATABASE_URL must use a loopback host and an SSH tunnel; "
        "public hosts and data.helema.cn are forbidden"
    )
if not value.username or not value.path or value.path == "/":
    raise SystemExit("ERROR: TARGET_DATABASE_URL must include a user and database name")
if port < 1 or port > 65535:
    raise SystemExit("ERROR: TARGET_DATABASE_URL port must be between 1 and 65535")
sys.stdout.buffer.write(host.encode() + b"\0" + str(port).encode() + b"\0")
PY
)
LOCAL_DB_HOST="${DB_ROUTE[0]:-}"
LOCAL_DB_PORT="${DB_ROUTE[1]:-}"
[[ -n "$LOCAL_DB_HOST" && -n "$LOCAL_DB_PORT" ]] || exit 1

if [[ "$LOCAL_DB_HOST" == "::1" ]]; then
  LOCAL_FORWARD="[::1]:$LOCAL_DB_PORT:$DATABASE_SSH_TARGET"
else
  LOCAL_FORWARD="$LOCAL_DB_HOST:$LOCAL_DB_PORT:$DATABASE_SSH_TARGET"
fi

TUNNEL_DIR="$(mktemp -d)"
chmod 700 "$TUNNEL_DIR"
CONTROL_SOCKET="$TUNNEL_DIR/ssh-control"
TUNNEL_OPEN=0
cleanup() {
  if (( TUNNEL_OPEN )); then
    ssh -S "$CONTROL_SOCKET" -O exit "$DATABASE_SSH_HOST" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TUNNEL_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "WQN Supabase migration deploy"
echo "Web dir: $WEB_DIR"
echo "Database route: loopback -> SSH $DATABASE_SSH_HOST -> private PostgreSQL"
echo "Extra args: ${EXTRA_ARGS[*]:-}"
if (( DRY_RUN_ONLY )); then echo "Mode: dry-run only"; fi
echo

echo "[tunnel] Opening localhost PostgreSQL tunnel"
ssh \
  -M -S "$CONTROL_SOCKET" -fN \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "$LOCAL_FORWARD" \
  "$DATABASE_SSH_HOST"
TUNNEL_OPEN=1

cd "$WEB_DIR" || { echo "ERROR: cannot cd to $WEB_DIR" >&2; exit 1; }
export SUPABASE_TELEMETRY_DISABLED=1

echo
echo "[1/4] Supabase CLI version"
supabase --version || { echo "ERROR: supabase --version failed." >&2; exit 1; }

echo
echo "[2/4] Current migration status"
supabase migration list --db-url "$TARGET_DATABASE_URL" \
  || { echo "ERROR: migration list failed." >&2; exit 1; }

echo
echo "[3/4] Dry run"
supabase db push --db-url "$TARGET_DATABASE_URL" --dry-run "${EXTRA_ARGS[@]}" \
  || { echo "ERROR: dry-run failed." >&2; exit 1; }

if (( DRY_RUN_ONLY )); then
  echo
  echo "Dry run complete. No migrations were applied."
  exit 0
fi

echo
echo "[4/4] Applying pending migrations"
if (( ${#EXTRA_ARGS[@]} > 0 )); then
  echo "WARNING: Running with ${EXTRA_ARGS[*]}."
fi
supabase db push --db-url "$TARGET_DATABASE_URL" "${EXTRA_ARGS[@]}" \
  || { echo "ERROR: db push failed." >&2; exit 1; }

echo
echo "[verify] Migration status after push"
supabase migration list --db-url "$TARGET_DATABASE_URL" \
  || { echo "ERROR: post-push migration list failed." >&2; exit 1; }

echo
echo "Supabase migration deploy complete."
