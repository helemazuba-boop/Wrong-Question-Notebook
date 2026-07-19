#!/usr/bin/env bash
set -Eeuo pipefail

export SUPABASE_TELEMETRY_DISABLED=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL to the old Cloud PostgreSQL URL}"

mode="${1:---dry-run}"
if [[ "$mode" != '--dry-run' && "$mode" != '--apply' ]]; then
  printf '%s\n' 'Usage: push-source-migrations.sh [--dry-run|--apply]' >&2
  exit 2
fi
for command_name in node psql supabase; do
  command -v "$command_name" >/dev/null || {
    printf '[source-push] Missing required command: %s\n' "$command_name" >&2
    exit 1
  }
done

if ! source_host="$(node -e '
  try {
    const value = new URL(process.argv[1]);
    if (!new Set(["postgres:", "postgresql:"]).has(value.protocol)) process.exit(2);
    if (!value.hostname) process.exit(2);
    process.stdout.write(value.hostname);
  } catch {
    process.exit(2);
  }
' "$SOURCE_DATABASE_URL")"; then
  printf '%s\n' '[source-push] SOURCE_DATABASE_URL must be a valid PostgreSQL URL.' >&2
  exit 1
fi
case "$source_host" in
  data.helema.cn | localhost | 127.0.0.1 | ::1 | '[::1]')
    printf '[source-push] Refusing old-Cloud push to host: %s\n' "$source_host" >&2
    exit 1
    ;;
esac

printf '%s\n' '[source-push] Running the v3 data preflight against the old Cloud source...'
psql "$SOURCE_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file "$script_dir/before-v3-push.sql"

printf '%s\n' '[source-push] Computing the exact pending migration plan through the direct DB URL...'
supabase db push --db-url "$SOURCE_DATABASE_URL" --dry-run

if [[ "$mode" == '--dry-run' ]]; then
  printf '%s\n' '[source-push] Dry run complete; no remote schema changes were made.'
  exit 0
fi

if [[ "${CONFIRM_SOURCE_MIGRATION_PUSH:-}" != 'apply-20260719-to-old-cloud' ]]; then
  printf '%s\n' '[source-push] Refusing apply without CONFIRM_SOURCE_MIGRATION_PUSH=apply-20260719-to-old-cloud.' >&2
  exit 1
fi

printf '%s\n' '[source-push] Applying pending migrations to the old Cloud source...'
supabase db push --db-url "$SOURCE_DATABASE_URL"

printf '%s\n' '[source-push] Verifying v3/security invariants and migration history...'
psql "$SOURCE_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file "$script_dir/source-preflight.sql"
missing_versions="$(psql "$SOURCE_DATABASE_URL" --no-align --tuples-only \
  --set ON_ERROR_STOP=1 --command "
    with expected(version) as (
      values ('20260719000000'::text), ('20260719010000'::text)
    )
    select version from expected
    except
    select version from supabase_migrations.schema_migrations
    order by version
  ")"
if [[ -n "$missing_versions" ]]; then
  printf '[source-push] Missing required migration history after push: %s\n' "$missing_versions" >&2
  exit 1
fi

printf '%s\n' '[source-push] Old Cloud source migrations and post-apply verification passed.'
