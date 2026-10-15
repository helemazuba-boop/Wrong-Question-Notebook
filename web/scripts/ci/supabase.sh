#!/usr/bin/env bash
set -euo pipefail
umask 077
web_root=$(cd "$(dirname "$0")/../.." && pwd)
repo_root=$(cd "$web_root/.." && pwd)
ci_workdir=${WQN_CI_SUPABASE_WORKDIR:-"$repo_root/.ci-local/supabase"}
action=${1:-start}
config_script="$web_root/scripts/ci/supabase-config.py"

if [[ "$action" == prepare ]]; then
  python3 "$config_script" prepare "$ci_workdir" --source "$web_root/supabase/config.toml"
  mkdir -p "$repo_root/artifacts"
  cp -R "$web_root/supabase/migrations" "$ci_workdir/supabase/migrations"
  mkdir -p "$ci_workdir/supabase/tests"
  cp -R "$web_root/supabase/tests/database" "$ci_workdir/supabase/tests/database"
elif [[ "$action" == start ]]; then
  python3 "$config_script" preflight "$ci_workdir"
  supabase start --workdir "$ci_workdir" --exclude studio,imgproxy,edge-runtime,logflare,vector,supavisor
  supabase status --workdir "$ci_workdir" --output json > "$ci_workdir/status.json"
elif [[ "$action" == test ]]; then
  db_url=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["DB_URL"])' "$ci_workdir/status.json")
  psql "$db_url" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command 'select version from supabase_migrations.schema_migrations order by version' > "$ci_workdir/applied-migrations.txt"
  python3 - "$web_root/supabase/migrations" "$ci_workdir/applied-migrations.txt" <<'PYTHON'
import pathlib, sys
expected = {file.name.split('_', 1)[0] for file in pathlib.Path(sys.argv[1]).glob('*.sql')}
actual = set(pathlib.Path(sys.argv[2]).read_text().split())
if actual != expected:
    sys.exit(f'Migration history mismatch: missing={sorted(expected-actual)}, extra={sorted(actual-expected)}')
print(f'Verified all {len(expected)} migration versions are applied')
PYTHON
  supabase test db --workdir "$ci_workdir"
  count=0
  for sql in "$web_root"/supabase/tests/*.sql; do
    psql "$db_url" --no-psqlrc --set ON_ERROR_STOP=1 --command BEGIN --file "$sql" --command ROLLBACK
    count=$((count+1))
  done
  [[ "$count" -ge 4 ]] || { echo 'Missing SQL contract tests' >&2; exit 1; }
  python3 "$web_root/scripts/ci/account-guard-migration-test.py" "$ci_workdir/status.json"
  node --test "$web_root/scripts/ci/__tests__/account-authorization-smoke.test.mjs"
  node "$web_root/scripts/ci/account-authorization-smoke.mjs" "$ci_workdir/status.json"
  node "$web_root/scripts/ci/account-data-test.mjs" "$ci_workdir/status.json"
elif [[ "$action" == upgrade ]]; then
  base=${WQN_MIGRATION_BASE_SHA:-$(cat "$repo_root/.github/ci-migration-baseline.txt")}
  git -C "$repo_root" cat-file -e "$base^{commit}"
  if git -C "$repo_root" diff --name-status "$base" HEAD -- web/supabase/migrations | grep -Eq '^[MDR]'; then
    echo 'Published migrations must be preserved; add a new migration.' >&2
    exit 1
  fi
  bash "$0" prepare
  rm -rf "$ci_workdir/supabase/migrations"
  git -C "$repo_root" archive "$base" web/supabase/migrations | tar -x -C "$ci_workdir"
  mv "$ci_workdir/web/supabase/migrations" "$ci_workdir/supabase/migrations"
  bash "$0" start
  db_url=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["DB_URL"])' "$ci_workdir/status.json")
  psql "$db_url" --no-psqlrc --set ON_ERROR_STOP=1 --file "$web_root/scripts/ci/upgrade-seed.sql"
  rm -rf "$ci_workdir/supabase/migrations"
  cp -R "$web_root/supabase/migrations" "$ci_workdir/supabase/migrations"
  supabase migration up --local --include-all --workdir "$ci_workdir"
  psql "$db_url" --no-psqlrc --set ON_ERROR_STOP=1 --file "$web_root/scripts/ci/upgrade-assert.sql"
  bash "$0" test
elif [[ "$action" == stop ]]; then
  if [[ -e "$ci_workdir/supabase/config.toml" ]]; then
    python3 "$config_script" project "$ci_workdir" > /dev/null
    supabase stop --workdir "$ci_workdir" --no-backup
  fi
elif [[ "$action" == logs ]]; then
  project=$(python3 "$config_script" project "$ci_workdir")
  docker logs "supabase_db_$project"
else
  echo "Unknown CI Supabase action: $action" >&2
  exit 1
fi
