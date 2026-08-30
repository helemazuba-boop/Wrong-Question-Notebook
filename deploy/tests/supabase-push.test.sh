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
printf 'supabase' >> "$WQN_TEST_CALLS"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$WQN_TEST_CALLS"; done
printf '\n' >> "$WQN_TEST_CALLS"
MOCK

cat > "$TMP_DIR/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
printf 'ssh' >> "$WQN_TEST_SSH_CALLS"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$WQN_TEST_SSH_CALLS"; done
printf '\n' >> "$WQN_TEST_SSH_CALLS"
MOCK
chmod +x "$TMP_DIR/bin/supabase" "$TMP_DIR/bin/ssh"

DB_URL='postgresql://supabase_admin:test-password@127.0.0.1:65432/postgres'
cat > "$TMP_DIR/repo/web/.env.production" <<EOF
TARGET_DATABASE_URL=$DB_URL
WQN_DATABASE_SSH_HOST=tencent
WQN_DATABASE_SSH_TARGET=127.0.0.1:5432
EOF
chmod 600 "$TMP_DIR/repo/web/.env.production"

export WQN_TEST_CALLS="$TMP_DIR/supabase.calls"
export WQN_TEST_SSH_CALLS="$TMP_DIR/ssh.calls"
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
grep -Fq '<-L> <127.0.0.1:65432:127.0.0.1:5432>' "$WQN_TEST_SSH_CALLS"
grep -Fq '<tencent>' "$WQN_TEST_SSH_CALLS"

cat > "$TMP_DIR/repo/web/.env.production" <<'EOF'
TARGET_DATABASE_URL=postgresql://supabase_admin:test-password@data.helema.cn:5432/postgres
WQN_DATABASE_SSH_HOST=tencent
WQN_DATABASE_SSH_TARGET=127.0.0.1:5432
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
WQN_DATABASE_SSH_HOST=tencent
WQN_DATABASE_SSH_TARGET=database.example.test:5432
EOF
if bash "$TMP_DIR/repo/deploy/supabase-push.sh" --dry-run-only \
    > "$TMP_DIR/rejected-target.output" 2>&1; then
  printf '%s\n' 'FAIL: public remote SSH tunnel target was accepted' >&2
  exit 1
fi

printf '%s\n' 'PASS: supabase push routing and flags'
