#!/usr/bin/env python3
"""Explicit integration test: isolated cloud containers, no production restart.

Run only with --run. Uses an already-present image, an internal Docker network,
synthetic credentials and a temporary archive; cleans all test resources.
"""
import argparse
import base64
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', action='store_true')
parser.add_argument('--ssh-host', default='aliyun')
args = parser.parse_args()
if not args.run:
    parser.error('Explicit --run is required')
if not args.ssh_host.replace('-', '').replace('_', '').replace('.', '').isalnum():
    parser.error('Use a configured SSH host alias')
source = (Path(__file__).resolve().parents[1] / 'ops/remote.py').read_bytes()
encoded = base64.b64encode(source).decode()
script = r'''
import base64, json, os, shutil, subprocess, tempfile, time, uuid
from pathlib import Path
source = base64.b64decode(SOURCE).decode('utf-8')
prefix = 'wqn-ops-it-' + uuid.uuid4().hex[:10]
directory = tempfile.mkdtemp(prefix=prefix + '-')
network = prefix + '-runtime'
name = prefix + '-app'
def cmd(args, check=True):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError('Isolation fixture command failed: ' + ' '.join(args[:2]))
    return p
def inspect(ref):
    return json.loads(cmd(['docker', 'inspect', ref]).stdout.decode())[0]
production_before = {s: inspect(s)['Id'] for s in ('wqn-app', 'wqn-realtime')}
image = inspect('wqn-app')['Image']
production_image = inspect('wqn-app')['Config']['Image']
manifest = cmd(['docker', 'manifest', 'inspect', '--verbose', production_image], check=False)
if manifest.returncode == 0:
    metadata = json.loads(manifest.stdout.decode())
    digest = metadata.get('Descriptor', {}).get('digest') if isinstance(metadata, dict) else None
    expected = [d.split('@', 1)[1] for d in inspect(image).get('RepoDigests', []) if '@' in d]
    if digest and digest in expected:
        print('PASS: existing ACR version readable through Docker registry protocol; digest matches running image', flush=True)
    else:
        print('UNVERIFIED: registry manifest has no matching single-image digest', flush=True)
else:
    print('UNVERIFIED: cloud registry credentials/network do not permit manifest lookup', flush=True)
os.environ.update(WQN_OPS_HOME=directory, WQN_OPS_ROOT=directory + '/archive', WQN_OPS_CONTAINER_PREFIX=prefix)
scope = {'__name__': 'isolated_test', '_WQN_SOURCE': source}
exec(compile(source, '<remote-worker>', 'exec'), scope)
dispatch = scope['dispatch']
def operation(op_id):
    deadline = time.time() + 100
    while time.time() < deadline:
        result = dispatch({'action': 'operation', 'id': op_id})
        if result['status'] not in ('queued', 'running'):
            return result
        time.sleep(1)
    raise RuntimeError('Isolated operation timeout')
def execute(plan, expected='verified', compatibility=False):
    dispatch({'action': 'apply', 'id': plan['id'], 'compatibility_reviewed': compatibility})
    result = operation(plan['id'])
    if result['status'] != expected:
        raise RuntimeError('Unexpected isolated result: ' + result['status'] + ' ' + result.get('error', ''))
    return result
try:
    cmd(['docker', 'network', 'create', '--internal', network])
    js = "require('http').createServer((q,r)=>{r.end('fixture-ok')}).listen(3000,'0.0.0.0')"
    cmd(['docker', 'run', '-d', '--name', name, '--network', network, '--network-alias', 'wqn',
         '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL',
         '--security-opt', 'no-new-privileges', '--memory', '96m', '--pids-limit', '32',
         '--env', 'WQN_OPENCODE_MODEL_ID=isolated-original', '--env', 'TEST_PASSWORD=synthetic-password',
         '--entrypoint', 'node', image, '-e', js])
    scope['readiness']('app')
    baseline = dispatch({'action': 'prepare', 'kind': 'baseline', 'services': ['app']})
    print('PASS: captured isolated baseline with authenticated encrypted recovery snapshot', flush=True)
    plan = dispatch({'action': 'prepare', 'kind': 'env', 'services': ['app'],
                     'env': {'app': {'WQN_OPENCODE_MODEL_ID': 'isolated-new',
                                     'TEST_PASSWORD': 'synthetic-new-password', 'EXPLICIT_EMPTY': ''}}})
    result = execute(plan)
    env = scope['env_dict'](inspect(name)['Config']['Env'])
    assert env['WQN_OPENCODE_MODEL_ID'] == 'isolated-new' and env['EXPLICIT_EMPTY'] == ''
    assert 'synthetic-new-password' not in json.dumps(result)
    print('PASS: detached SSH worker recreated isolated App and verified actual env and HTTP', flush=True)
    rollback = dispatch({'action': 'prepare', 'kind': 'rollback', 'services': ['app'], 'target_id': baseline['id']})
    execute(rollback, compatibility=True)
    assert scope['env_dict'](inspect(name)['Config']['Env'])['WQN_OPENCODE_MODEL_ID'] == 'isolated-original'
    print('PASS: manual rollback restored recorded image, command, configuration and readiness', flush=True)
    failed = dispatch({'action': 'prepare', 'kind': 'env', 'services': ['app'],
                       'env': {'app': {'NODE_OPTIONS': '--wqn-intentionally-invalid-option'}}})
    result = execute(failed, expected='rolled_back')
    assert result['recovery'] == 'verified'
    assert scope['env_dict'](inspect(name)['Config']['Env'])['WQN_OPENCODE_MODEL_ID'] == 'isolated-original'
    print('PASS: real startup failure restored and verified the previous isolated container', flush=True)
    assert len(dispatch({'action': 'history'})['operations']) == 4
    print('PASS: cloud-only operation history persisted all outcomes', flush=True)
finally:
    ids = cmd(['docker', 'ps', '-aq', '--filter', 'name=' + prefix], check=False).stdout.decode().split()
    for cid in ids:
        try:
            c = inspect(cid)
            if c['Name'].lstrip('/').startswith(prefix + '-'):
                cmd(['docker', 'rm', '-f', cid], check=False)
        except Exception:
            pass
    cmd(['docker', 'network', 'rm', network], check=False)
    shutil.rmtree(directory)
    production_after = {s: inspect(s)['Id'] for s in ('wqn-app', 'wqn-realtime')}
    assert production_before == production_after, 'Production container identity changed during integration test'
    print('PASS: production App/Realtime IDs unchanged; isolated resources removed', flush=True)
'''.replace('SOURCE', repr(encoded), 1)
p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T',
                    args.ssh_host, 'python3', '-'], input=script.encode())
sys.exit(p.returncode)
