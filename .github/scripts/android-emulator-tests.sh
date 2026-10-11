#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
capture_logcat() {
  timeout 15s adb logcat -d > "$repo_root/android-logcat.txt" 2>&1 || true
}
trap capture_logcat EXIT
wait_for_android() {
  local ready=0 readiness_deadline=$((SECONDS + 180))
  while ((SECONDS < readiness_deadline)); do
    local package_status activity_status provisioned booted
    package_status=$(timeout 10s adb shell service check package 2>/dev/null || true)
    activity_status=$(timeout 10s adb shell service check activity 2>/dev/null || true)
    provisioned=$(timeout 10s adb shell settings get global device_provisioned 2>/dev/null | tr -d '\r' || true)
    booted=$(timeout 10s adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    if [[ "$package_status" == *": found"* && "$activity_status" == *": found"* && "$provisioned" == 1 && "$booted" == 1 ]]; then
      ready=$((ready + 1))
      if ((ready >= 3)); then
        return 0
      fi
    else
      ready=0
    fi
    sleep 2
  done
  echo "Android package/activity/settings services did not become ready" >&2
  return 1
}
wait_for_android
cd "$repo_root/android"
./gradlew assembleDebug assembleDebugAndroidTest -PwqnCiAssets=true --no-daemon
# Check again after compiling, so a restarted framework cannot produce a
# successful Gradle invocation with zero actually executed native tests.
wait_for_android
./gradlew connectedDebugAndroidTest -PwqnCiAssets=true --no-daemon
