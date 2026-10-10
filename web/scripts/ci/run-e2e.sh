#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo_root"
docker info > /dev/null
bash web/scripts/ci/supabase.sh prepare
cleanup() {
  bash "$repo_root/web/scripts/ci/supabase.sh" stop
  rm -rf "$repo_root/.ci-local/supabase"
}
trap cleanup EXIT
bash web/scripts/ci/supabase.sh start
bash web/scripts/ci/e2e-certificates.sh trust
python3 web/scripts/ci/e2e-environment.py
source .ci-local/e2e.env
cd web
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run build
npm run test:e2e -- "$@"
