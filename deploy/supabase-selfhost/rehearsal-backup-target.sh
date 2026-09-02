#!/usr/bin/env bash
set -Eeuo pipefail

# Creates the mandatory rollback point before a Cloud-data rehearsal restore.
# This script is read-only with respect to PostgreSQL. It does not stop services,
# truncate tables, restore data, or modify Storage object bytes.

: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the tunneled self-hosted PostgreSQL URL}"
: "${TARGET_BACKUP_DIR:?Set TARGET_BACKUP_DIR to a new private directory outside the Git work tree}"
: "${CONFIRM_TARGET_DATABASE_HOST:?Set CONFIRM_TARGET_DATABASE_HOST to 127.0.0.1}"

for command_name in pg_dump pg_dumpall pg_restore psql python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '[target-backup] Missing required command: %s\n' "$command_name" >&2
    exit 1
  }
done

if [[ -e "$TARGET_BACKUP_DIR" ]]; then
  printf '[target-backup] Refusing existing output path: %s\n' "$TARGET_BACKUP_DIR" >&2
  exit 1
fi
install -d -m 700 "$TARGET_BACKUP_DIR"
umask 077

mapfile -d '' -t target_route < <(
  python3 - "$TARGET_DATABASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit

try:
    parsed = urlsplit(sys.argv[1])
    port = parsed.port or 5432
except ValueError as exc:
    raise SystemExit(f"invalid TARGET_DATABASE_URL: {exc}")
if parsed.scheme not in {"postgres", "postgresql"}:
    raise SystemExit("TARGET_DATABASE_URL must be a PostgreSQL URL")
if not parsed.hostname or not parsed.username or parsed.path in {"", "/"}:
    raise SystemExit("TARGET_DATABASE_URL must include hostname, user, and database")
sys.stdout.buffer.write(parsed.hostname.lower().encode() + b"\0")
sys.stdout.buffer.write(str(port).encode() + b"\0")
PY
)
target_host="${target_route[0]:-}"
target_port="${target_route[1]:-}"
if [[ "$target_host" != '127.0.0.1' || "$target_port" != '15432' ]]; then
  printf '%s\n' '[target-backup] Target must use the reviewed SSH tunnel at 127.0.0.1:15432.' >&2
  exit 1
fi
if [[ "$CONFIRM_TARGET_DATABASE_HOST" != "$target_host" ]]; then
  printf '%s\n' '[target-backup] CONFIRM_TARGET_DATABASE_HOST does not match the parsed target.' >&2
  exit 1
fi

server_version="$({
  psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --no-align --tuples-only \
    --command "begin read only; select current_setting('server_version_num'); commit;"
} | sed -n '2p')"
client_version="$(pg_dump --version | sed -nE 's/.* ([0-9]+)(\..*)?$/\1/p')"
server_major="$((server_version / 10000))"
if [[ -z "$client_version" || "$client_version" -lt "$server_major" ]]; then
  printf '[target-backup] pg_dump major %s cannot safely dump PostgreSQL major %s.\n' \
    "${client_version:-unknown}" "$server_major" >&2
  printf '%s\n' '[target-backup] Install PostgreSQL 17 client tools or set PATH to reviewed PostgreSQL 17 binaries.' >&2
  exit 1
fi

identity="$({
  psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --no-align --field-separator=$'\t' --tuples-only \
    --command "begin read only;
      select current_user, current_database(), current_setting('server_version'),
             (select rolsuper from pg_roles where rolname = current_user),
             pg_is_in_recovery();
      commit;"
} | sed -n '2p')"
IFS=$'\t' read -r database_user database_name database_version database_superuser database_recovery <<<"$identity"
if [[ "$database_superuser" != 't' || "$database_recovery" != 'f' ]]; then
  printf '%s\n' '[target-backup] Target must be a writable primary reached with a PostgreSQL superuser.' >&2
  exit 1
fi

printf '%s\n' '[target-backup] Capturing cluster roles and a full custom-format database dump...'
pg_dumpall --roles-only --database "$TARGET_DATABASE_URL" \
  > "$TARGET_BACKUP_DIR/roles.sql"
pg_dump --format=custom --compress=9 --blobs --verbose \
  --file "$TARGET_BACKUP_DIR/database.dump" \
  --dbname "$TARGET_DATABASE_URL" \
  2> "$TARGET_BACKUP_DIR/database-dump.log"
pg_restore --list "$TARGET_BACKUP_DIR/database.dump" \
  > "$TARGET_BACKUP_DIR/database.toc"

psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --csv --tuples-only \
  --command "begin read only;
    select version, name
    from supabase_migrations.schema_migrations
    order by version;
    commit;" \
  > "$TARGET_BACKUP_DIR/application-migrations.csv"
psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --csv --tuples-only \
  --command "begin read only;
    select version::text
    from auth.schema_migrations
    order by version;
    commit;" \
  > "$TARGET_BACKUP_DIR/auth-migrations.csv"
psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --csv --tuples-only \
  --command "begin read only;
    select id::text, name, hash
    from storage.migrations
    order by id;
    commit;" \
  > "$TARGET_BACKUP_DIR/storage-migrations.csv"

{
  printf 'created_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_host=%s\n' "$target_host"
  printf 'database_port=%s\n' "$target_port"
  printf 'database_name=%s\n' "$database_name"
  printf 'database_user=%s\n' "$database_user"
  printf 'database_version=%s\n' "$database_version"
  printf 'pg_dump_version=%s\n' "$(pg_dump --version)"
  printf '%s\n' 'storage_object_bytes_included=no'
} > "$TARGET_BACKUP_DIR/manifest.txt"

(
  cd "$TARGET_BACKUP_DIR"
  sha256sum roles.sql database.dump database-dump.log database.toc \
    application-migrations.csv auth-migrations.csv storage-migrations.csv manifest.txt \
    > SHA256SUMS
  sha256sum --check SHA256SUMS
)
touch "$TARGET_BACKUP_DIR/BACKUP_COMPLETE"
chmod 600 "$TARGET_BACKUP_DIR"/*

printf '[target-backup] Complete: %s\n' "$TARGET_BACKUP_DIR"
printf '%s\n' '[target-backup] This backup covers PostgreSQL only; Storage object bytes require a separate backend snapshot before object migration.'
