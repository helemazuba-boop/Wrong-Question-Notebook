#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

declare -A CFG=(
  [NEXT_PUBLIC_SUPABASE_URL]='https://data.example.test'
  [NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY]='publishable-test-value'
  [SUPABASE_URL]='https://data.example.test'
  [WQN_SUPABASE_EXPECTED_HOST]='data.example.test'
  [WQN_ALLOW_HTTP_SUPABASE_ORIGIN]=''
  [SUPABASE_SECRET_KEY]='server-test-value'
  [SUPABASE_SERVICE_ROLE_KEY]=''
  [SITE_URL]='https://app.example.test'
  [NEXT_PUBLIC_APP_URL]='https://app.example.test'
  [AI_PROVIDER]='openai'
  [AI_PROVIDER_API_KEY]='app-ai-test-value'
  [DASHSCOPE_API_KEY]='dashscope-test-value'
  [STEPFUN_API_KEY]='stepfun-batch-test-value'
  [STEP_API_KEY]='step-realtime-test-value'
  [STEP_TTS_MODEL]='stepaudio-test'
  [STEP_TTS_REALTIME_URL]='wss://step.example.test/realtime'
  [WQN_REALTIME_PROXY_SECRET]='shared-proxy-test-value'
  [WQN_INTERNAL_API_BASE]='http://wqn:3000'
  [WQN_INTERNAL_API_ALLOWED_HOST]='wqn'
  [WQN_ESP32_AI_AUDIO_URL_SECRET]='audio-test-value'
  [ACR_PASSWORD]='must-not-be-runtime'
  [NEXT_SERVER_ACTIONS_ENCRYPTION_KEY]='must-not-be-runtime-either'
  [TARGET_DATABASE_URL]='postgresql://admin:test@127.0.0.1:65432/postgres'
)

getv() {
  local key="$1"
  printf '%s' "${CFG[$key]:-}"
}

# shellcheck source=deploy/release-env-policy.sh
source "$DEPLOY_DIR/release-env-policy.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_key() {
  local file="$1" key="$2"
  grep -q "^${key}=" "$file" || fail "$key missing from $(basename "$file")"
}

assert_no_key() {
  local file="$1" key="$2"
  if grep -q "^${key}=" "$file"; then
    fail "$key leaked into $(basename "$file")"
  fi
}

validate_supabase_runtime_policy
make_runtime_env app "$TMP_DIR/app.env"
make_runtime_env realtime "$TMP_DIR/realtime.env"
make_env_hash_manifest "$TMP_DIR/app.env" "$TMP_DIR/app.sha256"
make_env_hash_manifest "$TMP_DIR/realtime.env" "$TMP_DIR/realtime.sha256"

[[ "$(stat -c '%a' "$TMP_DIR/app.env")" == 600 ]] || fail 'App env is not 0600'
[[ "$(stat -c '%a' "$TMP_DIR/realtime.env")" == 600 ]] || fail 'Realtime env is not 0600'

assert_key "$TMP_DIR/app.env" NEXT_PUBLIC_SUPABASE_URL
assert_key "$TMP_DIR/app.env" SUPABASE_SECRET_KEY
assert_key "$TMP_DIR/app.env" AI_PROVIDER_API_KEY
assert_key "$TMP_DIR/app.env" STEPFUN_API_KEY
assert_key "$TMP_DIR/realtime.env" SUPABASE_URL
assert_key "$TMP_DIR/realtime.env" SUPABASE_SECRET_KEY
assert_key "$TMP_DIR/realtime.env" STEP_API_KEY
assert_key "$TMP_DIR/realtime.env" WQN_INTERNAL_API_BASE

for key in \
  ACR_PASSWORD TARGET_DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY STEP_API_KEY STEP_TTS_MODEL
do
  assert_no_key "$TMP_DIR/app.env" "$key"
done
for key in \
  ACR_PASSWORD TARGET_DATABASE_URL NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY NEXT_PUBLIC_APP_URL SITE_URL \
  SUPABASE_SERVICE_ROLE_KEY NEXT_SERVER_ACTIONS_ENCRYPTION_KEY AI_PROVIDER_API_KEY \
  DASHSCOPE_API_KEY STEPFUN_API_KEY WQN_ESP32_AI_AUDIO_URL_SECRET
do
  assert_no_key "$TMP_DIR/realtime.env" "$key"
done

if grep -Fq 'server-test-value' "$TMP_DIR/app.sha256"; then
  fail 'hash manifest contains a secret value'
fi
if ! grep -Eq '^SUPABASE_SECRET_KEY=[0-9a-f]{64}$' "$TMP_DIR/app.sha256"; then
  fail 'App hash manifest is malformed'
fi

(
  CFG[SUPABASE_SERVICE_ROLE_KEY]='legacy-cloud-value'
  ! validate_supabase_runtime_policy >/dev/null 2>&1
) || fail 'legacy service-role key was accepted'

(
  CFG[SUPABASE_SERVICE_ROLE_KEY]=''
  CFG[NEXT_PUBLIC_SUPABASE_URL]='https://old-ref.supabase.co'
  CFG[SUPABASE_URL]='https://old-ref.supabase.co'
  CFG[WQN_SUPABASE_EXPECTED_HOST]='old-ref.supabase.co'
  ! validate_supabase_runtime_policy >/dev/null 2>&1
) || fail 'Supabase Cloud origin was accepted'

(
  CFG[SUPABASE_SERVICE_ROLE_KEY]=''
  CFG[SUPABASE_URL]='https://other.example.test'
  ! validate_supabase_runtime_policy >/dev/null 2>&1
) || fail 'mismatched App/Realtime origins were accepted'

printf '%s\n' 'PASS: release env policy'
