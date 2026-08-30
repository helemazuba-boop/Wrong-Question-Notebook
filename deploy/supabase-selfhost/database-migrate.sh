#!/usr/bin/env bash
set -Eeuo pipefail

# Migration hosts are often firewalled from analytics endpoints. Avoid a
# successful database operation being reported as failed during CLI shutdown.
export SUPABASE_TELEMETRY_DISABLED=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$script_dir/../../web"
migration_dir="$web_dir/supabase/migrations"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the self-hosted database URL}"
: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL explicitly for the one-time source clone}"

for command_name in diff find psql python3 sed sha256sum sort supabase; do
  command -v "$command_name" >/dev/null || {
    printf '[migration] Missing required command: %s\n' "$command_name" >&2
    exit 1
  }
done

source_query() {
  local sql="$1"
  (
    cd "$web_dir"
    supabase db query --db-url "$SOURCE_DATABASE_URL" --agent yes --output-format json "$sql"
  )
}

source_query_file() {
  local sql
  # db query accepts SQL, not psql backslash commands. Only discard complete
  # psql meta-command lines; preserve every SQL line verbatim.
  sql="$(sed -E '/^[[:space:]]*\\[[:alpha:]][[:alnum:]_]*([[:space:]].*)?$/d' "$1")"
  source_query "$sql"
}

source_dump() {
  local output_file="$1"
  shift
  (
    cd "$web_dir"
    supabase db dump --db-url "$SOURCE_DATABASE_URL" --file "$output_file" "$@"
  )
}

artifact_root="${MIGRATION_ARTIFACT_DIR:-$script_dir/artifacts/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$artifact_root"
chmod 700 "$artifact_root"
umask 077

find "$migration_dir" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' \
  | sed -nE 's/^([0-9]{14})_.*/\1/p' \
  | sort -u \
  > "$artifact_root/expected-migrations.txt"
source_query '
  select version, statements::text as statements, name
  from supabase_migrations.schema_migrations
  order by version
' > "$artifact_root/source-migration-history.json"
python3 "$script_dir/linked-query-output.py" migration-versions \
  "$artifact_root/source-migration-history.json" \
  > "$artifact_root/source-migrations.txt"
if ! diff -u \
  "$artifact_root/expected-migrations.txt" \
  "$artifact_root/source-migrations.txt" \
  > "$artifact_root/source-migrations.diff"; then
  printf '%s\n' '[migration] Source migration history differs from this checkout; refusing restore.' >&2
  printf '%s\n' '[migration] Apply/reconcile pending migrations before retrying.' >&2
  exit 1
fi
python3 "$script_dir/linked-query-output.py" migration-history-csv \
  "$artifact_root/source-migration-history.json" \
  > "$artifact_root/source-migration-history.csv"
source_query '
  select version::text as version
  from auth.schema_migrations
  order by version
' > "$artifact_root/source-auth-migrations.json"
python3 "$script_dir/linked-query-output.py" auth-migration-versions \
  "$artifact_root/source-auth-migrations.json" \
  > "$artifact_root/source-auth-migrations.txt"
source_query '
  select id::text as id, name, hash
  from storage.migrations
  order by storage.migrations.id
' > "$artifact_root/source-storage-migrations.json"
python3 "$script_dir/linked-query-output.py" storage-migration-history-csv \
  "$artifact_root/source-storage-migrations.json" \
  > "$artifact_root/source-storage-migrations.csv"

printf '%s\n' '[migration] Running source preflight...'
source_query_file "$script_dir/source-preflight.sql" \
  > "$artifact_root/source-preflight.txt"
source_query_file "$script_dir/row-counts.sql" \
  > "$artifact_root/source-row-counts.json"
python3 "$script_dir/linked-query-output.py" row-counts-tsv \
  "$artifact_root/source-row-counts.json" \
  > "$artifact_root/source-row-counts.tsv"

target_has_app_schema="$(psql "$TARGET_DATABASE_URL" -Atqc \
  "select case when to_regclass('public.user_profiles') is null then 'no' else 'yes' end")"
if [[ "$target_has_app_schema" != 'no' && "${ALLOW_NONEMPTY_TARGET:-0}" != '1' ]]; then
  printf '%s\n' '[migration] Target already contains WQN tables; refusing to overwrite.' >&2
  printf '%s\n' '[migration] Use a fresh target or explicitly set ALLOW_NONEMPTY_TARGET=1.' >&2
  exit 1
fi

# Restoring preserved object owners and disabling triggers/FKs through
# session_replication_role both require an administrative target connection.
# Fail before creating dumps instead of discovering this midway through the
# maintenance window.
target_is_superuser="$(psql "$TARGET_DATABASE_URL" -Atqc \
  "select rolsuper::text from pg_roles where rolname = current_user")"
if [[ "$target_is_superuser" != 'true' && "$target_is_superuser" != 't' ]]; then
  printf '%s\n' '[migration] TARGET_DATABASE_URL must authenticate as a PostgreSQL superuser.' >&2
  printf '%s\n' '[migration] Use the self-hosted supabase_admin maintenance credential, never the app runtime key.' >&2
  exit 1
fi
psql "$TARGET_DATABASE_URL" --no-align --tuples-only \
  --set ON_ERROR_STOP=1 \
  --command 'select version::text from auth.schema_migrations order by version' \
  > "$artifact_root/target-auth-migrations-before-restore.txt"
if ! diff -u \
  "$artifact_root/source-auth-migrations.txt" \
  "$artifact_root/target-auth-migrations-before-restore.txt" \
  > "$artifact_root/auth-migrations-before-restore.diff"; then
  printf '%s\n' '[migration] Source/target Auth migration history differs; refusing restore.' >&2
  printf '%s\n' '[migration] Align the self-hosted Auth image/schema with Cloud before retrying.' >&2
  exit 1
fi
psql "$TARGET_DATABASE_URL" --csv --tuples-only \
  --set ON_ERROR_STOP=1 \
  --command 'select id, name, hash from storage.migrations order by storage.migrations.id' \
  > "$artifact_root/target-storage-migrations-before-restore.csv"
if ! diff -u \
  "$artifact_root/source-storage-migrations.csv" \
  "$artifact_root/target-storage-migrations-before-restore.csv" \
  > "$artifact_root/storage-migrations-before-restore.diff"; then
  printf '%s\n' '[migration] Source/target Storage migration history differs; refusing restore.' >&2
  printf '%s\n' '[migration] Align the self-hosted Storage image/schema with Cloud before retrying.' >&2
  exit 1
fi

printf '%s\n' '[migration] Creating Supabase-compatible role/schema/data dumps...'
source_dump "$artifact_root/roles.sql" --role-only
source_dump "$artifact_root/schema.sql"
source_dump "$artifact_root/data.sql" --use-copy --data-only
sha256sum "$artifact_root/roles.sql" "$artifact_root/schema.sql" \
  "$artifact_root/data.sql" "$artifact_root/source-migration-history.csv" \
  > "$artifact_root/SHA256SUMS"

printf '%s\n' '[migration] Restoring into the self-hosted target in one transaction...'
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file "$artifact_root/roles.sql" \
  --file "$artifact_root/schema.sql" \
  --command 'set session_replication_role = replica' \
  --file "$artifact_root/data.sql" \
  --dbname "$TARGET_DATABASE_URL" \
  > "$artifact_root/restore.txt" \
  2> "$artifact_root/restore-error.txt"

printf '%s\n' '[migration] Reconstructing Supabase migration history...'
psql "$TARGET_DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 --command '
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    statements text[],
    name text
  );
  truncate table supabase_migrations.schema_migrations;
' --command '\copy supabase_migrations.schema_migrations(version, statements, name) from stdin with (format csv)' \
  < "$artifact_root/source-migration-history.csv"
psql "$TARGET_DATABASE_URL" --no-align --tuples-only \
  --set ON_ERROR_STOP=1 \
  --command 'select version from supabase_migrations.schema_migrations order by version' \
  > "$artifact_root/target-migrations.txt"
if ! diff -u \
  "$artifact_root/expected-migrations.txt" \
  "$artifact_root/target-migrations.txt" \
  > "$artifact_root/target-migrations.diff"; then
  printf '%s\n' '[migration] Target migration versions differ after restore.' >&2
  exit 1
fi
psql "$TARGET_DATABASE_URL" --csv --tuples-only \
  --set ON_ERROR_STOP=1 \
  --command 'select version, statements, name from supabase_migrations.schema_migrations order by version' \
  > "$artifact_root/target-migration-history.csv"
if ! diff -u \
  "$artifact_root/source-migration-history.csv" \
  "$artifact_root/target-migration-history.csv" \
  > "$artifact_root/migration-history.diff"; then
  printf '%s\n' '[migration] Source/target migration history differs after restore.' >&2
  exit 1
fi

printf '%s\n' '[migration] Verifying target invariants and exact row counts...'
psql "$TARGET_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file "$script_dir/target-verify.sql" \
  > "$artifact_root/target-verify.txt"
psql "$TARGET_DATABASE_URL" --no-align --tuples-only --field-separator $'\t' \
  --set ON_ERROR_STOP=1 --file "$script_dir/row-counts.sql" \
  > "$artifact_root/target-row-counts.tsv"
if ! diff -u \
  "$artifact_root/source-row-counts.tsv" \
  "$artifact_root/target-row-counts.tsv" \
  > "$artifact_root/row-counts.diff"; then
  printf '%s\n' '[migration] Source/target row counts differ; target is not accepted.' >&2
  exit 1
fi

printf '[migration] Database restore complete. Artifacts: %s\n' "$artifact_root"
printf '%s\n' '[migration] Storage object bytes are a separate gate; run migrate-storage.mjs next.'
