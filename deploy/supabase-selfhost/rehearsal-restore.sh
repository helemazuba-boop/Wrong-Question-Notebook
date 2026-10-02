#!/usr/bin/env bash
set -Eeuo pipefail

# Replaces only Cloud-owned Auth/application/Storage metadata rows on an
# already-migrated self-hosted target. Default mode is a read-only plan. The
# --apply path is intentionally gated and must not be run without approval.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
dump_dir="${DUMP_DIR:-$project_root/migration/supabase-20260831}"
mode='plan'

case "${1:---plan}" in
  --plan) mode='plan' ;;
  --apply) mode='apply' ;;
  *) printf '%s\n' 'usage: rehearsal-restore.sh [--plan|--apply]' >&2; exit 2 ;;
esac

: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the tunneled Tencent PostgreSQL URL}"
: "${REHEARSAL_ARTIFACT_DIR:?Set REHEARSAL_ARTIFACT_DIR to a new absolute private directory outside the repository}"
: "${CONFIRM_TARGET_DATABASE_HOST:?Set CONFIRM_TARGET_DATABASE_HOST to 127.0.0.1}"

for command_name in awk diff find node psql python3 rg sed sha256sum sort; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '[rehearsal] Missing required command: %s\n' "$command_name" >&2
    exit 1
  }
done

if [[ "$REHEARSAL_ARTIFACT_DIR" != /* ]]; then
  printf '%s\n' '[rehearsal] REHEARSAL_ARTIFACT_DIR must be absolute.' >&2
  exit 1
fi
case "$REHEARSAL_ARTIFACT_DIR/" in
  "$project_root/"*)
    printf '%s\n' '[rehearsal] Keep rehearsal artifacts outside the Git working tree.' >&2
    exit 1
    ;;
esac
if [[ -e "$REHEARSAL_ARTIFACT_DIR" ]]; then
  printf '[rehearsal] Refusing existing artifact path: %s\n' "$REHEARSAL_ARTIFACT_DIR" >&2
  exit 1
fi
install -d -m 700 "$REHEARSAL_ARTIFACT_DIR"
umask 077

data_sql="$dump_dir/data.sql"
for required_file in roles.sql schema.sql data.sql SHA256SUMS; do
  [[ -f "$dump_dir/$required_file" ]] || {
    printf '[rehearsal] Missing dump artifact: %s\n' "$dump_dir/$required_file" >&2
    exit 1
  }
done
(
  cd "$dump_dir"
  sha256sum --check SHA256SUMS
) > "$REHEARSAL_ARTIFACT_DIR/source-checksums.txt"

if [[ "$(sed -n '1p' "$data_sql")" != 'SET session_replication_role = replica;' ]]; then
  printf '%s\n' '[rehearsal] data.sql does not have the expected trigger-suppression prologue.' >&2
  exit 1
fi
rg -q '^RESET ALL;$' "$data_sql" || {
  printf '%s\n' '[rehearsal] data.sql does not restore session settings with RESET ALL.' >&2
  exit 1
}
if rg -n '^(CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT)[[:space:]]' "$data_sql" \
  > "$REHEARSAL_ARTIFACT_DIR/unexpected-data-statements.txt"; then
  printf '%s\n' '[rehearsal] data.sql contains unexpected schema or mutation statements.' >&2
  exit 1
fi

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
  printf '%s\n' '[rehearsal] Target must stay on the reviewed tunnel at 127.0.0.1:15432.' >&2
  exit 1
fi
if [[ "$CONFIRM_TARGET_DATABASE_HOST" != "$target_host" ]]; then
  printf '%s\n' '[rehearsal] CONFIRM_TARGET_DATABASE_HOST does not match the parsed target.' >&2
  exit 1
fi

is_protected_relation() {
  case "$1" in
    storage.buckets_analytics|storage.buckets_vectors|storage.vector_indexes) return 0 ;;
    *) return 1 ;;
  esac
}

awk '
  /^COPY / {
    relation=$2
    gsub(/"/, "", relation)
    rows=0
    in_copy=1
    next
  }
  in_copy && $0 == "\\." {
    printf "%s\t%d\n", relation, rows
    in_copy=0
    next
  }
  in_copy { rows++ }
' "$data_sql" > "$REHEARSAL_ARTIFACT_DIR/source-row-counts.tsv"

restore_tables=()
while IFS= read -r quoted_relation; do
  plain_relation="${quoted_relation//\"/}"
  if is_protected_relation "$plain_relation"; then
    protected_rows="$(awk -F '\t' -v relation="$plain_relation" '$1 == relation { print $2 }' \
      "$REHEARSAL_ARTIFACT_DIR/source-row-counts.tsv")"
    if [[ "$protected_rows" != '0' ]]; then
      printf '[rehearsal] Protected platform relation has source rows: %s=%s\n' \
        "$plain_relation" "$protected_rows" >&2
      exit 1
    fi
    continue
  fi
  restore_tables+=("$quoted_relation")
done < <(awk '/^COPY / { print $2 }' "$data_sql")

# These tables are present only on the migration-ahead target. They currently
# contain no data, but must join the TRUNCATE set because they reference users,
# subjects, and problems. A nonzero preflight count is a hard refusal.
restore_tables+=(
  '"public"."problem_ingestions"'
  '"public"."problem_ingestion_candidates"'
  '"public"."problem_ingestion_problem_links"'
)
mapfile -t restore_tables < <(printf '%s\n' "${restore_tables[@]}" | sort -u)

identity="$({
  psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --no-align \
    --field-separator=$'\t' --tuples-only \
    --command "begin read only;
      select current_user, current_database(), current_setting('server_version'),
             (select rolsuper from pg_roles where rolname = current_user),
             pg_is_in_recovery();
      commit;"
} | sed -n '1p')"
IFS=$'\t' read -r target_user target_database target_version target_superuser target_recovery <<<"$identity"
if [[ "$target_superuser" != 't' || "$target_recovery" != 'f' ]]; then
  printf '%s\n' '[rehearsal] Target must be a writable primary reached with a PostgreSQL superuser.' >&2
  exit 1
fi
printf '%s\t%s\t%s\t%s\n' "$target_user" "$target_database" "$target_version" "$target_host:$target_port" \
  > "$REHEARSAL_ARTIFACT_DIR/target-identity.tsv"

# Ensure every COPY column still exists on the migration-ahead target. This is
# read-only and catches stale or incompatible dump artifacts before the gate.
awk '
  BEGIN { print "\\set ON_ERROR_STOP on"; print "begin read only;" }
  /^COPY / {
    relation=$2
    statement=$0
    sub(/^COPY [^ ]+ \(/, "select ", statement)
    sub(/\) FROM stdin;$/, " from " relation " where false;", statement)
    print statement
  }
  END { print "commit;" }
' "$data_sql" \
  | psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --tuples-only \
      > "$REHEARSAL_ARTIFACT_DIR/column-compatibility.txt"

newer_table_rows="$(psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 \
  --no-align --tuples-only --command "begin read only;
    select
      (select count(*) from public.problem_ingestions)
      + (select count(*) from public.problem_ingestion_candidates)
      + (select count(*) from public.problem_ingestion_problem_links);
    commit;")"
if [[ "$newer_table_rows" != '0' ]]; then
  printf '%s\n' '[rehearsal] Migration-ahead problem_ingestion tables are nonempty; regenerate the Cloud dump.' >&2
  exit 1
fi

expected_migrations="$REHEARSAL_ARTIFACT_DIR/expected-migrations.txt"
target_migrations="$REHEARSAL_ARTIFACT_DIR/target-migrations.txt"
find "$project_root/web/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' \
  | sed -nE 's/^([0-9]{14})_.*/\1/p' | sort -u > "$expected_migrations"
psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --no-align --tuples-only \
  --command "begin read only;
    select version from supabase_migrations.schema_migrations order by version;
    commit;" > "$target_migrations"
if ! diff -u "$expected_migrations" "$target_migrations" \
  > "$REHEARSAL_ARTIFACT_DIR/target-migrations.diff"; then
  printf '%s\n' '[rehearsal] Target application migration history differs from this checkout.' >&2
  exit 1
fi

boundary_sql="$REHEARSAL_ARTIFACT_DIR/truncate-boundaries.sql"
{
  printf '%s\n' '\set ON_ERROR_STOP on' 'begin read only;' 'with truncated(relation_oid) as (values'
  for index in "${!restore_tables[@]}"; do
    plain_relation="${restore_tables[$index]//\"/}"
    if (( index > 0 )); then printf ',\n'; fi
    printf "  ('%s'::regclass)" "$plain_relation"
  done
  printf '%s\n' ')' \
    "select source_namespace.nspname || '.' || source_table.relname," \
    '       constraint_row.conname,' \
    "       target_namespace.nspname || '.' || target_table.relname" \
    'from pg_constraint constraint_row' \
    'join pg_class source_table on source_table.oid = constraint_row.conrelid' \
    'join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace' \
    'join pg_class target_table on target_table.oid = constraint_row.confrelid' \
    'join pg_namespace target_namespace on target_namespace.oid = target_table.relnamespace' \
    "where constraint_row.contype = 'f'" \
    '  and ((constraint_row.conrelid in (select relation_oid from truncated))' \
    '    <> (constraint_row.confrelid in (select relation_oid from truncated)))' \
    'order by 1, 2;' \
    'commit;'
} > "$boundary_sql"
psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --no-align \
  --field-separator=$'\t' --tuples-only --file "$boundary_sql" \
  > "$REHEARSAL_ARTIFACT_DIR/truncate-boundaries.tsv"
if [[ -s "$REHEARSAL_ARTIFACT_DIR/truncate-boundaries.tsv" ]]; then
  printf '%s\n' '[rehearsal] TRUNCATE set is not foreign-key closed; refusing CASCADE.' >&2
  exit 1
fi

psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --no-align \
  --field-separator=$'\t' --tuples-only \
  --command 'begin read only;' \
  --file "$script_dir/rehearsal-platform-fingerprint.sql" \
  --command 'commit;' \
  > "$REHEARSAL_ARTIFACT_DIR/platform-state-before.tsv"

{
  printf '%s\n' 'REHEARSAL DESTRUCTIVE PLAN (not executed in --plan mode)'
  printf 'target=%s/%s PostgreSQL %s via %s:%s\n' \
    "$target_user" "$target_database" "$target_version" "$target_host" "$target_port"
  printf 'source_data_sha256=%s\n' "$(sha256sum "$data_sql" | awk '{print $1}')"
  printf '%s\n' 'roles.sql=NOT APPLIED' 'schema.sql=NOT APPLIED' 'TRUNCATE CASCADE=NOT USED'
  printf '%s\n' 'transaction=one psql --single-transaction unit'
  printf '%s\n' 'trigger_handling=session_replication_role replica only during data COPY; origin before verification'
  printf 'truncate_restart_identity_tables=%d\n' "${#restore_tables[@]}"
  printf '%s\n' "${restore_tables[@]}"
  printf '%s\n' 'protected_relations:' \
    'auth.schema_migrations' \
    'storage.migrations' \
    'supabase_migrations.schema_migrations' \
    'storage.buckets_analytics' \
    'storage.buckets_vectors' \
    'storage.vector_indexes' \
    'storage.iceberg_namespaces' \
    'storage.iceberg_tables'
} > "$REHEARSAL_ARTIFACT_DIR/destructive-plan.txt"

if [[ "$mode" == 'plan' ]]; then
  sha256sum "$REHEARSAL_ARTIFACT_DIR"/* > "$REHEARSAL_ARTIFACT_DIR/PLAN_SHA256SUMS"
  printf '[rehearsal] Read-only plan complete: %s\n' "$REHEARSAL_ARTIFACT_DIR"
  printf '%s\n' '[rehearsal] No target rows, schemas, roles, sequences, or Storage bytes were changed.'
  exit 0
fi

: "${TARGET_BACKUP_DIR:?Set TARGET_BACKUP_DIR to a completed backup from rehearsal-backup-target.sh}"
if [[ "${CONFIRM_REHEARSAL_REPLACE_TARGET_DATA:-}" != 'replace-tencent-rehearsal-data' ]]; then
  printf '%s\n' '[rehearsal] Set CONFIRM_REHEARSAL_REPLACE_TARGET_DATA=replace-tencent-rehearsal-data.' >&2
  exit 1
fi
if [[ "${CONFIRM_TARGET_WRITES_STOPPED:-}" != 'target-writes-stopped' ]]; then
  printf '%s\n' '[rehearsal] Set CONFIRM_TARGET_WRITES_STOPPED=target-writes-stopped after quiescing target writers.' >&2
  exit 1
fi
if [[ ! -d "$TARGET_BACKUP_DIR" || -L "$TARGET_BACKUP_DIR" \
   || ! -f "$TARGET_BACKUP_DIR/BACKUP_COMPLETE" \
   || ! -f "$TARGET_BACKUP_DIR/database.dump" \
   || ! -f "$TARGET_BACKUP_DIR/roles.sql" \
   || ! -f "$TARGET_BACKUP_DIR/SHA256SUMS" ]]; then
  printf '%s\n' '[rehearsal] TARGET_BACKUP_DIR is not a complete rollback backup.' >&2
  exit 1
fi
(
  cd "$TARGET_BACKUP_DIR"
  sha256sum --check SHA256SUMS
) > "$REHEARSAL_ARTIFACT_DIR/backup-checksums.txt"
backup_database="$(awk -F= '$1 == "database_name" { print substr($0, index($0, "=") + 1) }' \
  "$TARGET_BACKUP_DIR/manifest.txt")"
backup_host="$(awk -F= '$1 == "database_host" { print substr($0, index($0, "=") + 1) }' \
  "$TARGET_BACKUP_DIR/manifest.txt")"
if [[ "$backup_database" != "$target_database" || "$backup_host" != "$target_host" ]]; then
  printf '%s\n' '[rehearsal] Backup identity does not match the current target.' >&2
  exit 1
fi

restore_prefix="$REHEARSAL_ARTIFACT_DIR/restore-prefix.sql"
{
  printf '%s\n' '\set ON_ERROR_STOP on' \
    "set local lock_timeout = '30s';" \
    'set local statement_timeout = 0;' \
    "select pg_advisory_xact_lock(hashtextextended('wqn-cloud-data-rehearsal', 0));" \
    'truncate table'
  for index in "${!restore_tables[@]}"; do
    if (( index > 0 )); then printf ',\n'; fi
    printf '  %s' "${restore_tables[$index]}"
  done
  printf '%s\n' '' 'restart identity;'
} > "$restore_prefix"

expected_counts_sql="$REHEARSAL_ARTIFACT_DIR/expected-counts.sql"
{
  printf '%s\n' '\set ON_ERROR_STOP on' 'do $$' 'declare actual_rows bigint;' 'begin'
  while IFS=$'\t' read -r relation expected_rows; do
    if is_protected_relation "$relation"; then continue; fi
    printf '  select count(*) into actual_rows from %s;\n' "$relation"
    printf "  if actual_rows <> %s then raise exception 'row-count mismatch for %s: expected %s, got %%', actual_rows; end if;\n" \
      "$expected_rows" "$relation" "$expected_rows"
  done < "$REHEARSAL_ARTIFACT_DIR/source-row-counts.tsv"
  for relation in public.problem_ingestions public.problem_ingestion_candidates public.problem_ingestion_problem_links; do
    printf '  select count(*) into actual_rows from %s;\n' "$relation"
    printf "  if actual_rows <> 0 then raise exception 'row-count mismatch for %s: expected 0, got %%', actual_rows; end if;\n" \
      "$relation"
  done
  printf '%s\n' 'end' '$$;'
} > "$expected_counts_sql"

printf '%s\n' '[rehearsal] Applying approved replacement in one transaction...'
if ! psql "$TARGET_DATABASE_URL" -X --single-transaction --set ON_ERROR_STOP=1 \
  --file "$restore_prefix" \
  --file "$data_sql" \
  --file "$expected_counts_sql" \
  --file "$script_dir/rehearsal-verify.sql" \
  > "$REHEARSAL_ARTIFACT_DIR/restore.txt" \
  2> "$REHEARSAL_ARTIFACT_DIR/restore-error.txt"; then
  printf '%s\n' '[rehearsal] Restore failed and the transaction was rolled back.' >&2
  exit 1
fi

psql "$TARGET_DATABASE_URL" -X --quiet --set ON_ERROR_STOP=1 --no-align \
  --field-separator=$'\t' --tuples-only \
  --command 'begin read only;' \
  --file "$script_dir/rehearsal-platform-fingerprint.sql" \
  --command 'commit;' \
  > "$REHEARSAL_ARTIFACT_DIR/platform-state-after.tsv"
if ! diff -u \
  "$REHEARSAL_ARTIFACT_DIR/platform-state-before.tsv" \
  "$REHEARSAL_ARTIFACT_DIR/platform-state-after.tsv" \
  > "$REHEARSAL_ARTIFACT_DIR/platform-state.diff"; then
  printf '%s\n' '[rehearsal] Protected platform state changed unexpectedly; do not accept this rehearsal.' >&2
  exit 1
fi

psql "$TARGET_DATABASE_URL" -X --set ON_ERROR_STOP=1 --no-align \
  --field-separator=$'\t' --tuples-only \
  --file "$script_dir/rehearsal-verify.sql" \
  > "$REHEARSAL_ARTIFACT_DIR/post-restore-verify.tsv"

sha256sum "$REHEARSAL_ARTIFACT_DIR"/* > "$REHEARSAL_ARTIFACT_DIR/APPLY_SHA256SUMS"
touch "$REHEARSAL_ARTIFACT_DIR/APPLY_COMPLETE"
chmod 600 "$REHEARSAL_ARTIFACT_DIR"/*
printf '[rehearsal] Restore and verification complete: %s\n' "$REHEARSAL_ARTIFACT_DIR"
printf '%s\n' '[rehearsal] Storage object bytes were not copied; keep target traffic disabled until the separate Storage gate passes.'
