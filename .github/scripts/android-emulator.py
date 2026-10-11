#!/usr/bin/env python3
"""Bound API 37 rendering costs and wait for first-boot memory pressure to settle."""
import dataclasses
import os
from pathlib import Path
import subprocess
import sys
import time


def configure_display(config: str) -> str:
    values = {'hw.lcd.width': '720', 'hw.lcd.height': '1280', 'hw.lcd.density': '320'}
    lines = [line for line in config.splitlines() if line.partition('=')[0].strip() not in values]
    lines.extend(f'{key}={value}' for key, value in values.items())
    return '\n'.join(lines) + '\n'


def available_memory(meminfo: str) -> int:
    for line in meminfo.splitlines():
        if line.startswith('MemAvailable:'):
            parts = line.split()
            if len(parts) == 3 and parts[2] == 'kB' and int(parts[1]) >= 0:
                return int(parts[1])
    raise ValueError('Missing or invalid MemAvailable in /proc/meminfo')


def last_kill(logcat: str) -> str:
    return next((line for line in reversed(logcat.splitlines()) if "Kill '" in line), '')


@dataclasses.dataclass
class Readiness:
    quiet_seconds: float = 30
    guest_min_kib: int = 1536 * 1024
    host_min_kib: int = 2048 * 1024
    last_kill: str = ''
    quiet_since: float | None = None

    def observe(self, now: float, guest_kib: int, host_kib: int, kill: str) -> bool:
        if kill != self.last_kill:
            self.last_kill = kill
            self.quiet_since = None
        if guest_kib < self.guest_min_kib or host_kib < self.host_min_kib:
            self.quiet_since = None
            return False
        if self.quiet_since is None:
            self.quiet_since = now
        return now - self.quiet_since >= self.quiet_seconds


def adb(*args: str, timeout: int = 15) -> str:
    serial = f'emulator-{os.environ.get("EMULATOR_PORT", "5554")}'
    result = subprocess.run(['adb', '-s', serial, *args], capture_output=True, text=True,
                            timeout=timeout, check=True)
    return result.stdout.replace('\r', '')


def wait_for_memory() -> None:
    if int(adb('shell', 'getprop', 'ro.build.version.sdk').strip()) < 37:
        return
    with open('android-emulator-readiness.txt', 'w') as log:
        def report(message: str) -> None:
            print(message, flush=True)
            print(message, file=log, flush=True)

        # sys.boot_completed does not mean that BOOT_COMPLETED receivers finished.
        # Wait without flushing deferred broadcasts or changing Android's lmkd policy.
        report('Waiting for API 37 first-boot broadcasts to finish')
        report(adb('shell', 'cmd', 'activity', 'wait-for-broadcast-idle', timeout=180).strip())
        readiness = Readiness()
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            guest_kib = available_memory(adb('shell', 'cat', '/proc/meminfo'))
            host_kib = available_memory(Path('/proc/meminfo').read_text())
            kill = last_kill(adb('logcat', '-d', '-b', 'all', '-v', 'monotonic',
                                 '-s', 'lowmemorykiller:I', '*:S'))
            now = time.monotonic()
            ready = readiness.observe(now, guest_kib, host_kib, kill)
            quiet = 0 if readiness.quiet_since is None else now - readiness.quiet_since
            report(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} '
                   f'guest_available_mib={guest_kib // 1024} host_available_mib={host_kib // 1024} '
                   f'kill_quiet_seconds={quiet:.1f} last_kill={kill or "none"}')
            if ready:
                report('API 37 memory readiness passed; starting instrumentation once')
                return
            time.sleep(5)
        raise RuntimeError('API 37 did not reach 30 seconds without lmkd kills and sufficient available memory')


def main() -> None:
    if sys.argv[1:] == ['wait']:
        wait_for_memory()
    elif len(sys.argv) == 3 and sys.argv[1] == 'configure':
        if int(sys.argv[2].partition('.')[0]) >= 37:
            avd_home = Path(os.environ.get('ANDROID_AVD_HOME', str(Path.home() / '.android/avd')))
            config = avd_home / 'test.avd/config.ini'
            config.write_text(configure_display(config.read_text()))
            print('API 37 display: 720x1280 at 320 dpi; image, RAM and heap unchanged')
    else:
        raise ValueError('Usage: android-emulator.py configure API | wait')


if __name__ == '__main__':
    main()
