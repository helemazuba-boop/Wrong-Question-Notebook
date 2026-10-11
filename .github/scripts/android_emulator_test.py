"""Exercise first-boot readiness with memory pressure and lmkd event sequences."""
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('android_emulator', Path(__file__).with_name('android-emulator.py'))
emulator = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = emulator
spec.loader.exec_module(emulator)


class ReadinessTests(unittest.TestCase):
    def test_first_sample_cannot_admit_tests(self):
        policy = emulator.Readiness()
        self.assertFalse(policy.observe(0, 4096 * 1024, 8192 * 1024, 'boot kill'))
        self.assertFalse(policy.observe(29, 4096 * 1024, 8192 * 1024, 'boot kill'))
        self.assertTrue(policy.observe(30, 4096 * 1024, 8192 * 1024, 'boot kill'))

    def test_new_kill_resets_quiet_period_despite_available_memory(self):
        policy = emulator.Readiness()
        policy.observe(0, 4096 * 1024, 8192 * 1024, 'first kill')
        self.assertFalse(policy.observe(29, 4096 * 1024, 8192 * 1024, 'new kill'))
        self.assertFalse(policy.observe(30, 4096 * 1024, 8192 * 1024, 'new kill'))
        self.assertTrue(policy.observe(59, 4096 * 1024, 8192 * 1024, 'new kill'))

    def test_guest_pressure_resets_quiet_period(self):
        policy = emulator.Readiness()
        policy.observe(0, 4096 * 1024, 8192 * 1024, '')
        self.assertFalse(policy.observe(29, 1024 * 1024, 8192 * 1024, ''))
        self.assertFalse(policy.observe(30, 4096 * 1024, 8192 * 1024, ''))
        self.assertFalse(policy.observe(59, 4096 * 1024, 8192 * 1024, ''))
        self.assertTrue(policy.observe(60, 4096 * 1024, 8192 * 1024, ''))

    def test_host_pressure_blocks_admission(self):
        policy = emulator.Readiness()
        self.assertFalse(policy.observe(0, 4096 * 1024, 1024 * 1024, ''))
        self.assertFalse(policy.observe(60, 4096 * 1024, 1024 * 1024, ''))
        self.assertFalse(policy.observe(61, 4096 * 1024, 8192 * 1024, ''))
        self.assertTrue(policy.observe(91, 4096 * 1024, 8192 * 1024, ''))

    def test_available_memory_includes_reclaimable_cache(self):
        self.assertEqual(4378912, emulator.available_memory(
            'MemTotal: 6067484 kB\nMemFree: 173508 kB\nMemAvailable: 4378912 kB\n'))
        with self.assertRaises(ValueError):
            emulator.available_memory('MemFree: 173508 kB\n')

    def test_only_actual_kill_records_reset_readiness(self):
        self.assertEqual('123 lowmemorykiller: Kill \'app\'', emulator.last_kill(
            "--------- beginning of system\n123 lowmemorykiller: Kill 'app'\n124 lowmemorykiller: poll\n"))
        self.assertEqual('', emulator.last_kill('--------- beginning of system\n'))

    def test_display_configuration_preserves_ram_image_and_heap(self):
        config = 'hw.ramSize=1536M\nhw.ramSize=6144M\nvm.heapSize=256M\nimage.sysdir.1=system-images/android-37.2-beta3/google_apis_ps16k/x86_64/\nhw.lcd.width=1080\nhw.lcd.width=1080\nhw.lcd.height=2220\nhw.lcd.density=440\n'
        changed = emulator.configure_display(config)
        self.assertIn('hw.ramSize=1536M\nhw.ramSize=6144M\nvm.heapSize=256M\n', changed)
        self.assertIn('image.sysdir.1=system-images/android-37.2-beta3/google_apis_ps16k/x86_64/\n', changed)
        self.assertEqual(1, changed.count('hw.lcd.width='))
        self.assertIn('hw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=320\n', changed)
        self.assertEqual(changed, emulator.configure_display(changed))


if __name__ == '__main__':
    unittest.main()
