"""Exercise port collisions and reject cleanup of a developer-owned stack."""
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('config', pathlib.Path(__file__).with_name('supabase-config.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class StackIsolationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workdir = pathlib.Path(self.temp.name) / 'stack'
        self.source = ROOT / 'supabase/config.toml'

    def test_ports_are_distinct_and_available(self):
        config.prepare(self.source, self.workdir)
        project, settings = config.owned_project(self.workdir)
        self.assertTrue(project.startswith('wqn-ci-'))
        self.assertFalse(settings['db']['seed']['enabled'])
        ports = [settings['api']['port'], settings['db']['port'], settings['db']['shadow_port'],
                 settings['db']['pooler']['port'], settings['studio']['port'],
                 settings['inbucket']['port'], settings['analytics']['port'],
                 settings['edge_runtime']['inspector_port']]
        self.assertEqual(len(set(ports)), 8)
        config.preflight(self.workdir)

    def test_two_stacks_have_different_container_names(self):
        other = self.workdir.with_name('other')
        config.prepare(self.source, self.workdir)
        config.prepare(self.source, other)
        self.assertNotEqual(config.owned_project(self.workdir)[0], config.owned_project(other)[0])

    def test_occupied_database_port_is_diagnosed(self):
        config.prepare(self.source, self.workdir)
        _, settings = config.owned_project(self.workdir)
        with socket.socket() as sock:
            sock.bind(('0.0.0.0', settings['db']['port']))
            with self.assertRaisesRegex(ValueError, r'occupied.*fresh stack'):
                config.preflight(self.workdir)

    def test_prepare_preserves_existing_config(self):
        config.prepare(self.source, self.workdir)
        path = self.workdir / 'supabase/config.toml'
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            config.prepare(self.source, self.workdir)
        self.assertEqual(path.read_bytes(), before)

    def test_cleanup_rejects_changed_project(self):
        config.prepare(self.source, self.workdir)
        (self.workdir / 'ownership.json').write_text(json.dumps({'project_id': 'developer'}))
        with self.assertRaisesRegex(ValueError, 'unowned'):
            config.owned_project(self.workdir)

    def stop(self):
        # A sentinel CLI makes any accidental invocation visible without Docker.
        cli = pathlib.Path(self.temp.name) / 'supabase'
        cli.write_text('#!/bin/sh\nexit 99\n')
        cli.chmod(0o700)
        return subprocess.run(['bash', str(ROOT / 'scripts/ci/supabase.sh'), 'stop'],
                              env={**os.environ, 'WQN_CI_SUPABASE_WORKDIR': str(self.workdir),
                                   'PATH': f'{self.temp.name}:{os.environ["PATH"]}'},
                              capture_output=True, text=True)

    def test_cleanup_before_prepare_does_not_invoke_cli(self):
        self.assertEqual(self.stop().returncode, 0)

    def test_cleanup_does_not_stop_unowned_stack(self):
        config.prepare(self.source, self.workdir)
        (self.workdir / 'ownership.json').unlink()
        self.assertEqual(self.stop().returncode, 1)


if __name__ == '__main__':
    unittest.main()
