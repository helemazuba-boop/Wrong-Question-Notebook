#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
capture_logcat() {
  timeout 15s adb logcat -d > "$repo_root/android-logcat.txt" 2>&1 || true
}
trap capture_logcat EXIT
cd "$repo_root/android"
# Build before checking device readiness: a newer system image can finish boot
# while its package/activity services are still initializing or restarting.
./gradlew assembleDebug assembleDebugAndroidTest -PwqnCiAssets=true --no-daemon
ready=0
readiness_deadline=$((SECONDS + 120))
while ((SECONDS < readiness_deadline)); do
  package_status=$(timeout 10s adb shell service check package 2>/dev/null || true)
  activity_status=$(timeout 10s adb shell service check activity 2>/dev/null || true)
  if [[ "$package_status" == *": found"* && "$activity_status" == *": found"* ]]; then
    ready=$((ready + 1))
    if ((ready >= 3)); then
      break
    fi
  else
    ready=0
  fi
  sleep 2
done
if ((ready < 3)); then
  echo "Android package/activity services did not become ready" >&2
  exit 1
fi
./gradlew connectedDebugAndroidTest -PwqnCiAssets=true --no-daemon
