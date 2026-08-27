#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
set +x

runner_dir="${TARGET_INFRA_SMOKE_RUNNER_DIR:-/root/wqn-storage-migration-20260827}"
log_file="$runner_dir/target-infra-smoke.txt"
target_origin="${SUPABASE_PUBLIC_URL:-http://10.77.0.2:8000}"
confirmed_target_origin="${CONFIRM_SUPABASE_PUBLIC_ORIGIN:-$target_origin}"
smoke_container="wqn-target-infra-smoke-$$"

cleanup() {
  docker rm --force "$smoke_container" >/dev/null 2>&1 || true
  unset SUPABASE_PUBLIC_URL CONFIRM_SUPABASE_PUBLIC_ORIGIN
  unset SUPABASE_PUBLISHABLE_KEY wqn_app_image smoke_container
}
trap cleanup EXIT

cd "$runner_dir"

if [[ -t 0 ]]; then
  read -rsp 'Target Supabase publishable key: ' SUPABASE_PUBLISHABLE_KEY
  printf '\n'
else
  SUPABASE_PUBLISHABLE_KEY="$(cat)"
fi
if [[ -z "$SUPABASE_PUBLISHABLE_KEY" ]]; then
  printf '%s\n' 'ERROR: Target Supabase publishable key is empty' >&2
  exit 1
fi

SUPABASE_PUBLIC_URL="$target_origin"
CONFIRM_SUPABASE_PUBLIC_ORIGIN="$confirmed_target_origin"
export SUPABASE_PUBLIC_URL CONFIRM_SUPABASE_PUBLIC_ORIGIN
export SUPABASE_PUBLISHABLE_KEY

wqn_app_image="$(docker inspect --format '{{.Config.Image}}' wqn-app)"
node_version="$(docker run --rm --entrypoint node "$wqn_app_image" --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
printf 'Runner image: %s\nRunner Node: %s\n' "$wqn_app_image" "$node_version"
if ((node_major < 22)); then
  printf '%s\n' 'ERROR: runner Node must be >= 22' >&2
  exit 1
fi

set +e
timeout 90s docker run --rm \
  --name "$smoke_container" \
  --network host \
  --user 0:0 \
  --volume "$runner_dir:/runner:ro" \
  --workdir /runner \
  --entrypoint node \
  --env SUPABASE_PUBLIC_URL \
  --env CONFIRM_SUPABASE_PUBLIC_ORIGIN \
  --env SUPABASE_PUBLISHABLE_KEY \
  "$wqn_app_image" \
  target-infra-smoke.mjs 2>&1 \
  | tee "$log_file"
smoke_status="${PIPESTATUS[0]}"
set -e

chmod 600 "$log_file"
if [[ "$smoke_status" -eq 0 ]]; then
  printf '%s\n' 'TARGET INFRA SMOKE PASSED'
else
  printf 'TARGET INFRA SMOKE FAILED: %s\n' "$smoke_status" >&2
fi
exit "$smoke_status"
