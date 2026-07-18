#!/usr/bin/env bash
# ============================================================
# WQN build & deploy entry - WSL/bash port of build.bat
# ============================================================
# Thin wrapper around build-and-push.ps1 (run via pwsh).
#
# Default target (matches build.bat): build, push, then deploy to
# Aliyun ECS. -DeployAliyun is appended automatically unless it is
# already present in the args.
#
# USAGE:
#   ./build.sh                       # build + push + deploy (default tag)
#   ./build.sh -Tag v1.2.3           # explicit tag
#   ./build.sh -Tag v1.2.3 -RecreateBuilder
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PS_SCRIPT="$SCRIPT_DIR/build-and-push.ps1"

if [[ ! -f "$PS_SCRIPT" ]]; then
  echo "[ERROR] PowerShell build script not found: $PS_SCRIPT" >&2
  exit 1
fi
if ! command -v pwsh >/dev/null 2>&1; then
  echo "[ERROR] 'pwsh' not found on PATH. Install PowerShell on Linux first." >&2
  exit 1
fi

echo
echo "WQN build and deploy entry:"
echo "  deploy/build.sh"
echo "  deploy/build.sh -Tag v1.2.3"
echo
echo "Default target:"
echo "  Build, push, then deploy to Aliyun ECS"
echo

# If -DeployAliyun not already in args, append it (case-insensitive, matches build.bat).
has_deploy=0
for a in "$@"; do
  if [[ "${a,,}" == "-deployaliyun" ]]; then
    has_deploy=1
    break
  fi
done

if (( has_deploy )); then
  pwsh -NoProfile -File "$PS_SCRIPT" "$@"
else
  pwsh -NoProfile -File "$PS_SCRIPT" "$@" -DeployAliyun
fi
rc=$?

echo
if (( rc == 0 )); then
  echo "[DONE] Build script completed successfully."
else
  echo "[ERROR] Build script failed with exit code $rc." >&2
fi
exit $rc
