#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
capture_logcat() {
  timeout 15s adb logcat -d > "$repo_root/android-logcat.txt" 2>&1 || true
}
trap capture_logcat EXIT
cd "$repo_root/android"
./gradlew connectedDebugAndroidTest -PwqnCiAssets=true --no-daemon
