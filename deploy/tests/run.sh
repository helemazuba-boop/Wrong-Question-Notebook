#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

for script in \
  "$DEPLOY_DIR/release.sh" \
  "$DEPLOY_DIR/release-env-policy.sh" \
  "$DEPLOY_DIR/release-remote.sh" \
  "$DEPLOY_DIR/supabase-push.sh" \
  "$DEPLOY_DIR/supabase-selfhost/database-migrate.sh"
do
  bash -n "$script"
done

if grep -R -n --exclude-dir=tests --include='*.sh' --include='*.bat' \
    -- '--linked' "$DEPLOY_DIR"; then
  printf '%s\n' 'FAIL: executable deployment path still contains --linked' >&2
  exit 1
fi

grep -Fq 'supabase db push --db-url "$TARGET_DATABASE_URL"' \
  "$DEPLOY_DIR/supabase-push.sh"
grep -Fq 'RT_ENV_FILE="$HOME/.env.wqn-realtime"' \
  "$DEPLOY_DIR/release-remote.sh"
grep -Fq 'temp="$(mktemp "$target_dir/.wqn-env.tmp.XXXXXX")"' \
  "$DEPLOY_DIR/release-remote.sh"
grep -Fq 'chmod 600 "$temp"' "$DEPLOY_DIR/release-remote.sh"
grep -Fq 'mv -f -- "$temp" "$target"' "$DEPLOY_DIR/release-remote.sh"

bash "$SCRIPT_DIR/release-env-policy.test.sh"
bash "$SCRIPT_DIR/release-remote.test.sh"
bash "$SCRIPT_DIR/supabase-push.test.sh"

printf '%s\n' 'PASS: deploy script test suite'
