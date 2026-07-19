#!/usr/bin/env bash
set -Eeuo pipefail

export SUPABASE_TELEMETRY_DISABLED=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the new self-hosted PostgreSQL URL}"

mode="${1:---dry-run}"
if [[ "$mode" != '--dry-run' && "$mode" != '--apply' ]]; then
  printf '%s\n' 'Usage: push-target-migrations.sh [--dry-run|--apply]' >&2
  exit 2
fi
for command_name in node psql supabase; do
  command -v "$command_name" >/dev/null || {
    printf '[target-push] Missing required command: %s\n' "$command_name" >&2
    exit 1
  }
done

if ! target_host="$(node -e '
  try {
    const value = new URL(process.argv[1]);
    if (!new Set(["postgres:", "postgresql:"]).has(value.protocol)) process.exit(2);
    if (!value.hostname) process.exit(2);
    process.stdout.write(value.hostname);
  } catch {
    process.exit(2);
  }
' "$TARGET_DATABASE_URL")"; then
  printf '%s\n' '[target-push] TARGET_DATABASE_URL must be a valid PostgreSQL URL.' >&2
  exit 1
fi
case "$target_host" in
  *.supabase.co | *.pooler.supabase.com)
    printf '[target-push] Refusing greenfield initialization against Supabase Cloud: %s\n' "$target_host" >&2
    exit 1
    ;;
esac

if [[ "${CONFIRM_TARGET_DATABASE_HOST:-}" != "$target_host" ]]; then
  printf '[target-push] Refusing target access until CONFIRM_TARGET_DATABASE_HOST exactly equals: %s\n' "$target_host" >&2
  exit 1
fi

printf '%s\n' '[target-push] Verifying that the self-hosted target has no WQN schema...'
psql "$TARGET_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file "$script_dir/target-empty-preflight.sql"

printf '%s\n' '[target-push] Computing the exact migration plan for the greenfield target...'
(
  cd "$repo_root/web"
  supabase db push --db-url "$TARGET_DATABASE_URL" --dry-run
)

if [[ "$mode" == '--dry-run' ]]; then
  printf '%s\n' '[target-push] Dry run complete; the target was not modified.'
  exit 0
fi

if [[ "${CONFIRM_M7_GREENFIELD_INITIALIZATION:-}" != 'initialize-m7-greenfield' ]]; then
  printf '%s\n' '[target-push] Refusing apply without CONFIRM_M7_GREENFIELD_INITIALIZATION=initialize-m7-greenfield.' >&2
  exit 1
fi

printf '%s\n' '[target-push] Applying repository migrations to the new self-hosted target...'
(
  cd "$repo_root/web"
  supabase db push --db-url "$TARGET_DATABASE_URL"
)

printf '%s\n' '[target-push] Verifying schema, RLS, token hashing and fixed definer search paths...'
psql "$TARGET_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file "$script_dir/target-verify.sql"

missing_versions="$(psql "$TARGET_DATABASE_URL" --no-align --tuples-only \
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
  printf '[target-push] Missing required M7 migration history: %s\n' "$missing_versions" >&2
  exit 1
fi

printf '%s\n' '[target-push] Greenfield self-hosted database initialization passed.'
