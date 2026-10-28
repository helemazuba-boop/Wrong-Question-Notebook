#!/usr/bin/env python3
"""The legacy entry delegates to the same engine as the console."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest import mock
DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
from ops import core

class EntryTests(unittest.TestCase):
    def test_entry_routes_to_shared_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / 'python3'
            python.write_text('#!/usr/bin/python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            python.chmod(0o700)
            for flags, expected in (([], 'env'), (['--check'], 'env-check'), (['--preview'], 'env-preview')):
                result = subprocess.check_output(['bash', str(DEPLOY / 'update-env.sh'), *flags], text=True,
                    env=dict(os.environ, PATH=str(root) + ':' + os.environ['PATH']))
                args = json.loads(result)
                self.assertEqual(args[1], expected)
                self.assertTrue(args[0].endswith('ops/cli.py'))

    def test_shared_policy_covers_powershell_runtime_keys(self):
        import re
        source = (DEPLOY / 'build-and-push.ps1').read_text()
        block = re.search(r'\$script:RuntimeVarKeys = @\((.*?)\n\)', source, re.S)[1]
        expected = set(re.findall(r'"([A-Z][A-Z0-9_]+)"', block))
        self.assertTrue(expected <= core.policy()['APP_RUNTIME_KEYS'])

    def test_unsupported_model_is_not_silently_accepted(self):
        values = {k: 'fixture-value' for k in core.policy()['APP_REQUIRED_RUNTIME_KEYS']}
        values['WQN_OPENCODE_FALLBACK_MODEL'] = 'fixture-sensitive-model'
        with self.assertRaises(core.OpsError) as error:
            core.runtime_values(values=values)
        self.assertIn('WQN_OPENCODE_FALLBACK_MODEL', str(error.exception))
        self.assertNotIn('fixture-sensitive-model', str(error.exception))

class EnvCheckTests(unittest.TestCase):
    def run_check(self, values):
        from ops import cli
        out, err = StringIO(), StringIO()
        with mock.patch.object(core, 'dotenv', return_value=values),                 redirect_stdout(out), redirect_stderr(err):
            return cli.main(['env-check']), out.getvalue(), err.getvalue()

    def accepted_values(self):
        policy = core.policy()
        keys = policy['APP_REQUIRED_RUNTIME_KEYS'] | policy['REALTIME_REQUIRED_RUNTIME_KEYS']
        return {key: 'fixture-value' for key in keys}

    def test_rejects_the_keys_release_rejects(self):
        values = self.accepted_values()
        values['WQN_OPENCODE_FALLBACK_MODEL'] = 'fixture-sensitive-model'
        code, out, err = self.run_check(values)
        self.assertEqual(code, 1)
        self.assertIn('WQN_OPENCODE_FALLBACK_MODEL', err)
        self.assertNotIn('fixture-sensitive-model', err)
        self.assertNotIn('Validated', out)

    def test_accepts_the_file_release_accepts(self):
        code, out, err = self.run_check(self.accepted_values())
        self.assertEqual(code, 0, err)
        self.assertIn('Validated', out)

if __name__ == '__main__':
    unittest.main(verbosity=2)
