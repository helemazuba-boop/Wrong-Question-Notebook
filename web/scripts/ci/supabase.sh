#!/usr/bin/env bash
set -euo pipefail
umask 077
web_root=$(cd "$(dirname "$0")/../.." && pwd)
repo_root=$(cd "$web_root/.." && pwd)
ci_workdir=${WQN_CI_SUPABASE_WORKDIR:-"$repo_root/.ci-local/supabase"}
action=${1:-start}

if [[ "$action" == prepare ]]; then
  if [[ -e "$ci_workdir/supabase/config.toml" ]]; then
    echo "Refusing to overwrite an existing CI stack: $ci_workdir" >&2
    exit 1
  fi
  mkdir -p "$ci_workdir/supabase" "$repo_root/artifacts"
  python3 - "$web_root/supabase/config.toml" "$ci_workdir/supabase/config.toml" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
text = re.sub(r'^project_id = .*$', 'project_id = "wqn-ci"', text, flags=re.M)
text = re.sub(r'(\[db.seed\]\n(?:#[^\n]*\n)*)enabled = true', r'\1enabled = false', text)
pathlib.Path(sys.argv[2]).write_text(text)
PY
  cp -R "$web_root/supabase/migrations" "$ci_workdir/supabase/migrations"
  mkdir -p "$ci_workdir/supabase/tests"
  cp -R "$web_root/supabase/tests/database" "$ci_workdir/supabase/tests/database"
elif [[ "$action" == start ]]; then
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
  supabase stop --workdir "$ci_workdir" --no-backup
else
  echo "Unknown CI Supabase action: $action" >&2
  exit 1
fi
