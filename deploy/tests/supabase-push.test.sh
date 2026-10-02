#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/repo/deploy" "$TMP_DIR/repo/web" "$TMP_DIR/bin"
cp "$DEPLOY_DIR/supabase-push.sh" "$TMP_DIR/repo/deploy/supabase-push.sh"

cat > "$TMP_DIR/bin/supabase" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'supabase' >> "$WQN_TEST_EVENTS"
printf 'supabase' >> "$WQN_TEST_CALLS"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$WQN_TEST_CALLS"; done
printf '\n' >> "$WQN_TEST_CALLS"
MOCK

cat > "$TMP_DIR/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
if [[ " $* " == *' sudo docker inspect '* ]]; then
  printf '%s\n' 'inspect' >> "$WQN_TEST_EVENTS"
else
  printf '%s\n' 'tunnel' >> "$WQN_TEST_EVENTS"
fi
printf 'ssh' >> "$WQN_TEST_SSH_CALLS"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$WQN_TEST_SSH_CALLS"; done
printf '\n' >> "$WQN_TEST_SSH_CALLS"
if [[ " $* " == *' sudo docker inspect '* ]]; then
  printf '%s\n' "${WQN_TEST_CONTAINER_IP:-172.19.0.9}"
fi
MOCK

cat > "$TMP_DIR/bin/psql" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'psql' >> "$WQN_TEST_EVENTS"
printf 'psql' >> "$WQN_TEST_PSQL_CALLS"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$WQN_TEST_PSQL_CALLS"; done
printf '\n' >> "$WQN_TEST_PSQL_CALLS"
if [[ "${WQN_TEST_PSQL_FAIL:-0}" == 1 ]]; then
  exit 1
fi
printf '%s\n' '1'
MOCK
chmod +x "$TMP_DIR/bin/supabase" "$TMP_DIR/bin/ssh" "$TMP_DIR/bin/psql"

DB_URL='postgresql://supabase_admin:test-password@127.0.0.1:15432/postgres'
cat > "$TMP_DIR/repo/web/.env.production" <<EOF
TARGET_DATABASE_URL=$DB_URL
EOF
chmod 600 "$TMP_DIR/repo/web/.env.production"

export WQN_TEST_CALLS="$TMP_DIR/supabase.calls"
export WQN_TEST_SSH_CALLS="$TMP_DIR/ssh.calls"
export WQN_TEST_PSQL_CALLS="$TMP_DIR/psql.calls"
export WQN_TEST_EVENTS="$TMP_DIR/events"
export PATH="$TMP_DIR/bin:$PATH"
# Must not override the reviewed dotenv source.
export TARGET_DATABASE_URL='postgresql://wrong:wrong@data.helema.cn:5432/postgres'

bash "$TMP_DIR/repo/deploy/supabase-push.sh" --include-all --dry-run-only \
  > "$TMP_DIR/output"

grep -Fq "supabase <migration> <list> <--db-url> <$DB_URL>" "$WQN_TEST_CALLS"
grep -Fq "supabase <db> <push> <--db-url> <$DB_URL> <--dry-run> <--include-all>" "$WQN_TEST_CALLS"
if grep -Fq -- '--linked' "$WQN_TEST_CALLS"; then
  printf '%s\n' 'FAIL: supabase-push used --linked' >&2
  exit 1
fi
grep -Fq "<sudo docker inspect --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' supabase-db>" "$WQN_TEST_SSH_CALLS"
grep -Fq '<-L> <127.0.0.1:15432:172.19.0.9:5432>' "$WQN_TEST_SSH_CALLS"
grep -Fq '<tencent>' "$WQN_TEST_SSH_CALLS"
grep -Fq "psql <$DB_URL>" "$WQN_TEST_PSQL_CALLS"
[[ "$(sed -n '1,4p' "$WQN_TEST_EVENTS" | tr '\n' ' ')" == 'inspect tunnel psql supabase ' ]]

cat > "$TMP_DIR/repo/web/.env.production" <<'EOF'
TARGET_DATABASE_URL=postgresql://supabase_admin:test-password@data.helema.cn:5432/postgres
EOF
: > "$WQN_TEST_SSH_CALLS"
if bash "$TMP_DIR/repo/deploy/supabase-push.sh" --dry-run-only \
    > "$TMP_DIR/rejected.output" 2>&1; then
  printf '%s\n' 'FAIL: public/data.helema.cn PostgreSQL URL was accepted' >&2
  exit 1
fi
[[ ! -s "$WQN_TEST_SSH_CALLS" ]] || {
  printf '%s\n' 'FAIL: SSH started before rejecting the public database URL' >&2
  exit 1
}

cat > "$TMP_DIR/repo/web/.env.production" <<EOF
TARGET_DATABASE_URL=$DB_URL
EOF
: > "$WQN_TEST_CALLS"
: > "$WQN_TEST_PSQL_CALLS"
: > "$WQN_TEST_SSH_CALLS"
: > "$WQN_TEST_EVENTS"
export WQN_TEST_PSQL_FAIL=1
if bash "$TMP_DIR/repo/deploy/supabase-push.sh" --dry-run-only \
    > "$TMP_DIR/preflight-failed.output" 2>&1; then
  printf '%s\n' 'FAIL: Supabase push continued after PostgreSQL preflight failure' >&2
  exit 1
fi
[[ ! -s "$WQN_TEST_CALLS" ]] || {
  printf '%s\n' 'FAIL: Supabase CLI ran after PostgreSQL preflight failure' >&2
  exit 1
}
grep -Fq '<-L> <127.0.0.1:15432:172.19.0.9:5432>' "$WQN_TEST_SSH_CALLS"
unset WQN_TEST_PSQL_FAIL

: > "$WQN_TEST_CALLS"
: > "$WQN_TEST_SSH_CALLS"
export WQN_TEST_CONTAINER_IP='8.8.8.8'
if bash "$TMP_DIR/repo/deploy/supabase-push.sh" --dry-run-only \
    > "$TMP_DIR/invalid-inspect.output" 2>&1; then
  printf '%s\n' 'FAIL: public docker-inspect address was accepted' >&2
  exit 1
fi
if grep -Fq '<-L>' "$WQN_TEST_SSH_CALLS"; then
  printf '%s\n' 'FAIL: tunnel opened after invalid supabase-db inspection' >&2
  exit 1
fi

printf '%s\n' 'PASS: supabase push routing and flags'
