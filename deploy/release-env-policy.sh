#!/usr/bin/env bash
# Runtime environment policy shared by release.sh and its tests.
# The caller must provide getv KEY, which reads web/.env.production as data.

APP_RUNTIME_KEYS=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
  WQN_SUPABASE_EXPECTED_HOST
  WQN_ALLOW_HTTP_SUPABASE_ORIGIN
  SUPABASE_SECRET_KEY
  NEXT_PUBLIC_APP_URL
  NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL
  SITE_URL
  CRON_SECRET
  AI_PROVIDER
  AI_PROVIDER_BASE_URL
  AI_PROVIDER_API_KEY
  GEMINI_API_KEY
  ANTHROPIC_API_KEY
  AI_MODEL_EXTRACTION
  AI_MODEL_CATEGORISATION
  AI_MODEL_PROBLEM_MARKING
  AI_MODEL_DIGEST
  AI_REQUEST_TIMEOUT_MS
  AI_EXTRACTION_PROVIDER_MAX_RPS
  DASHSCOPE_API_KEY
  DASHSCOPE_CHAT_API_KEY
  DASHSCOPE_CHAT_API_KEY_STD
  DASHSCOPE_CHAT_API_KEY_PRO
  DASHSCOPE_ENDPOINT
  DASHSCOPE_OPENAI_BASE_URL
  DASHSCOPE_OPENAI_BASE_URL_STD
  DASHSCOPE_OPENAI_BASE_URL_PRO
  DASHSCOPE_ASR_MODEL
  DASHSCOPE_ASR_TASK_URL
  DASHSCOPE_TASK_STATUS_BASE_URL
  DASHSCOPE_ASR_LANGUAGE_HINTS
  DASHSCOPE_ASR_POLL_INTERVAL_MS
  DASHSCOPE_ASR_POLL_ATTEMPTS
  DASHSCOPE_CHAT_MODEL
  DASHSCOPE_CHAT_MODEL_STD
  DASHSCOPE_CHAT_MODEL_PRO
  STEPFUN_API_KEY
  STEPFUN_ASR_URL
  STEPFUN_ASR_MODEL
  STEPFUN_ASR_LANGUAGE
  STEPFUN_ASR_HOTWORDS
  STEPFUN_ASR_ENABLE_ITN
  WQN_ESP32_AI_ASR_PROVIDER
  WQN_ESP32_AI_ASR_FALLBACK_PROVIDER
  WQN_ESP32_AI_CHAT_PROVIDER
  WQN_ESP32_AI_SYSTEM_PROMPT
  WQN_ESP32_AI_PUBLIC_BASE_URL
  WQN_ESP32_AI_AUDIO_URL_SECRET
  WQN_ESP32_AI_AUDIO_TMP_DIR
  WQN_ESP32_AI_AUDIO_URL_TTL_MS
  WQN_ESP32_AI_PROVIDER_TIMEOUT_MS
  WQN_ESP32_AI_LLM_TIMEOUT_MS
  WQN_ESP32_AI_ASR_TIMEOUT_MS
  WQN_ESP32_AI_STREAM_EVENT_ID_BASE
  WQN_REALTIME_PROXY_SECRET
  WQN_INTERNAL_API_ALLOWED_HOST
  PROBLEM_MARKING_SECRET
  PROBLEM_REVIEW_PROJECTION_SECRET
)

# Deliberately independent of APP_RUNTIME_KEYS. In particular, Realtime does
# not receive App AI provider keys, ACR credentials, cron credentials, the
# Server Actions key, the browser publishable key, or App public URLs.
REALTIME_RUNTIME_KEYS=(
  SUPABASE_URL
  WQN_SUPABASE_EXPECTED_HOST
  WQN_ALLOW_HTTP_SUPABASE_ORIGIN
  SUPABASE_SECRET_KEY
  STEP_API_KEY
  STEP_TTS_MODEL
  STEP_TTS_REALTIME_URL
  WQN_AI_REALTIME_ENABLED
  WQN_REALTIME_PROXY_SECRET
  WQN_INTERNAL_API_BASE
  WQN_FLASH_PROXY_BIND
  WQN_FLASH_PROXY_PORT
  WQN_FLASH_ALLOWED_VOICES
  LOG_LEVEL
)

APP_REQUIRED_RUNTIME_KEYS=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
  WQN_SUPABASE_EXPECTED_HOST
  SUPABASE_SECRET_KEY
  SITE_URL
  WQN_REALTIME_PROXY_SECRET
  WQN_INTERNAL_API_ALLOWED_HOST
)

REALTIME_REQUIRED_RUNTIME_KEYS=(
  SUPABASE_URL
  WQN_SUPABASE_EXPECTED_HOST
  SUPABASE_SECRET_KEY
  STEP_API_KEY
  WQN_REALTIME_PROXY_SECRET
  WQN_INTERNAL_API_BASE
)

# These are checked inside the running containers after deployment. Image
# defaults such as NODE_ENV, PORT, and HOSTNAME are intentionally not listed.
APP_FORBIDDEN_RUNTIME_KEYS=(
  ACR_SERVER
  ACR_NAMESPACE
  ACR_REPO
  ACR_USERNAME
  ACR_PASSWORD
  TARGET_DATABASE_URL
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  STEP_API_KEY
  STEP_TTS_MODEL
  STEP_TTS_REALTIME_URL
)

REALTIME_FORBIDDEN_RUNTIME_KEYS=(
  ACR_SERVER
  ACR_NAMESPACE
  ACR_REPO
  ACR_USERNAME
  ACR_PASSWORD
  TARGET_DATABASE_URL
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
  NEXT_PUBLIC_APP_URL
  SITE_URL
  SUPABASE_SERVICE_ROLE_KEY
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  CRON_SECRET
  AI_PROVIDER
  AI_PROVIDER_BASE_URL
  AI_PROVIDER_API_KEY
  GEMINI_API_KEY
  ANTHROPIC_API_KEY
  DASHSCOPE_API_KEY
  DASHSCOPE_CHAT_API_KEY
  DASHSCOPE_CHAT_API_KEY_STD
  DASHSCOPE_CHAT_API_KEY_PRO
  STEPFUN_API_KEY
  WQN_ESP32_AI_AUDIO_URL_SECRET
  PROBLEM_MARKING_SECRET
  PROBLEM_REVIEW_PROJECTION_SECRET
)

runtime_keys_for() {
  case "$1" in
    app) printf '%s\n' "${APP_RUNTIME_KEYS[@]}" ;;
    realtime) printf '%s\n' "${REALTIME_RUNTIME_KEYS[@]}" ;;
    *)
      printf 'ERROR: unknown runtime component: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

forbidden_runtime_keys_for() {
  case "$1" in
    app) printf '%s\n' "${APP_FORBIDDEN_RUNTIME_KEYS[@]}" ;;
    realtime) printf '%s\n' "${REALTIME_FORBIDDEN_RUNTIME_KEYS[@]}" ;;
    *)
      printf 'ERROR: unknown runtime component: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

make_forbidden_key_file() {
  local component="$1" out="$2"
  forbidden_runtime_keys_for "$component" > "$out"
  chmod 600 "$out"
}

make_runtime_env() {
  local component="$1" out="$2" key value
  : > "$out"
  chmod 600 "$out"

  while IFS= read -r key; do
    value="$(getv "$key")"
    [[ -n "$value" ]] || continue
    if [[ "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
      printf 'ERROR: %s contains a newline and cannot be put in a Docker env file.\n' "$key" >&2
      return 1
    fi
    printf '%s=%s\n' "$key" "$value" >> "$out"
  done < <(runtime_keys_for "$component")
}

make_env_hash_manifest() {
  local env_file="$1" out="$2" line key value digest
  : > "$out"
  chmod 600 "$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    digest="$(printf '%s' "$value" | sha256sum | awk '{print $1}')"
    printf '%s=%s\n' "$key" "$digest" >> "$out"
  done < "$env_file"
}

validate_supabase_runtime_policy() {
  local app_url realtime_url expected_host allowed_http legacy_key
  app_url="$(getv NEXT_PUBLIC_SUPABASE_URL)"
  realtime_url="$(getv SUPABASE_URL)"
  expected_host="$(getv WQN_SUPABASE_EXPECTED_HOST)"
  allowed_http="$(getv WQN_ALLOW_HTTP_SUPABASE_ORIGIN)"
  legacy_key="$(getv SUPABASE_SERVICE_ROLE_KEY)"

  if [[ -n "$legacy_key" ]]; then
    cat >&2 <<'ERR'
ERROR: SUPABASE_SERVICE_ROLE_KEY is still populated in web/.env.production.
Migrate to SUPABASE_SECRET_KEY and remove the legacy value before deployment;
release.sh never uploads the legacy key to either runtime.
ERR
    return 1
  fi

  python3 - "$app_url" "$realtime_url" "$expected_host" "$allowed_http" <<'PY'
import sys
from urllib.parse import urlsplit

app_raw, realtime_raw, expected_host, allowed_http = sys.argv[1:]

def parse(name, raw):
    try:
        value = urlsplit(raw)
    except ValueError as exc:
        raise SystemExit(f"ERROR: {name} is not a valid URL: {exc}")
    if value.scheme not in {"http", "https"} or not value.hostname:
        raise SystemExit(f"ERROR: {name} must be an absolute HTTP(S) URL")
    host = value.hostname.lower().rstrip(".")
    if host == "supabase.co" or host.endswith(".supabase.co"):
        raise SystemExit(f"ERROR: {name} still points to Supabase Cloud")
    return value, host

app, app_host = parse("NEXT_PUBLIC_SUPABASE_URL", app_raw)
realtime, realtime_host = parse("SUPABASE_URL", realtime_raw)
expected = expected_host.lower().rstrip(".")
if not expected:
    raise SystemExit("ERROR: WQN_SUPABASE_EXPECTED_HOST is required")
if app_host != expected or realtime_host != expected:
    raise SystemExit("ERROR: App and Realtime Supabase URLs must match WQN_SUPABASE_EXPECTED_HOST")
if app.scheme != realtime.scheme or app.netloc.lower() != realtime.netloc.lower():
    raise SystemExit("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_URL must use the same origin")

origin = f"{app.scheme}://{app.netloc}"
if app.scheme == "http":
    if allowed_http != origin:
        raise SystemExit("ERROR: HTTP Supabase requires WQN_ALLOW_HTTP_SUPABASE_ORIGIN to exactly match its origin")
elif allowed_http:
    raise SystemExit("ERROR: WQN_ALLOW_HTTP_SUPABASE_ORIGIN must be empty when Supabase uses HTTPS")
PY
}
