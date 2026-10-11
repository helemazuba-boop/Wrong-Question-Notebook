#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
device_serial="emulator-${EMULATOR_PORT:-5554}"
memory_monitor_pid=""
capture_memory() {
  {
    date -u +%Y-%m-%dT%H:%M:%SZ
    free -m
    timeout 10s adb -s "$device_serial" shell 'getprop ro.build.version.sdk; getconf PAGESIZE; cat /proc/meminfo; cat /proc/zoneinfo; cat /proc/pressure/memory' || true
  } >> "$repo_root/android-emulator-memory.txt" 2>&1
}
capture_logcat() {
  if [[ -n "$memory_monitor_pid" ]]; then
    kill "$memory_monitor_pid" 2>/dev/null || true
    wait "$memory_monitor_pid" 2>/dev/null || true
  fi
  timeout 15s adb -s "$device_serial" logcat -d > "$repo_root/android-logcat.txt" 2>&1 || true
  capture_memory
}
trap capture_logcat EXIT
wait_for_android() {
  local ready=0 readiness_deadline=$((SECONDS + 180))
  while ((SECONDS < readiness_deadline)); do
    local package_status activity_status provisioned booted
    package_status=$(timeout 10s adb -s "$device_serial" shell service check package 2>/dev/null || true)
    activity_status=$(timeout 10s adb -s "$device_serial" shell service check activity 2>/dev/null || true)
    provisioned=$(timeout 10s adb -s "$device_serial" shell settings get global device_provisioned 2>/dev/null | tr -d '\r' || true)
    booted=$(timeout 10s adb -s "$device_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
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
(
  while true; do
    capture_memory
    sleep 5
  done
) &
memory_monitor_pid=$!
cd "$repo_root"
python3 .github/scripts/android-emulator.py wait
cd "$repo_root/android"
# The workflow assembles APKs before booting the emulator, keeping compilation
# separate from the API 37 image's first-boot memory and CPU demands.
./gradlew connectedDebugAndroidTest -PwqnCiAssets=true --no-daemon --max-workers=1 --no-parallel \
  '-Dorg.gradle.jvmargs=-Xmx1024m -Dfile.encoding=UTF-8'
