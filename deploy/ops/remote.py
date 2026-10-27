#!/usr/bin/env python3
"""SSH worker. Python 3.6 compatible; durable state lives on the target host.

Public records never contain env values. Private recovery material is encrypted
and authenticated with a host-local key. No image archives are produced.
"""
import base64
import contextlib
import datetime
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = 1
HOME_DIR = Path(os.environ.get('WQN_OPS_HOME', pwd.getpwuid(os.getuid()).pw_dir))
ROOT = Path(os.environ.get('WQN_OPS_ROOT', str(HOME_DIR / '.wqn-ops')))
PREFIX = os.environ.get('WQN_OPS_CONTAINER_PREFIX', 'wqn')
SERVICES = {'app': PREFIX + '-app', 'realtime': PREFIX + '-realtime'}
SECRET = re.compile(r'KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE|DATABASE|DSN|ENCRYPT|SESSION', re.I)
ID = re.compile(r'^[a-f0-9]{32}$')


class OpsError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def run(args, data=None, timeout=30, check=True):
    try:
        p = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise OpsError('Command unavailable or timed out: ' + args[0])
    if check and p.returncode:
        # Docker errors can contain environment values. Keep them out of API errors.
        raise OpsError('Command failed: ' + ' '.join(args[:2]))
    return p


def inspect(ref, required=True):
    p = run(['docker', 'inspect', ref], check=False)
    if p.returncode:
        if required:
            raise OpsError('Cannot inspect requested container/image')
        return None
    try:
        return json.loads(p.stdout.decode('utf-8'))[0]
    except (ValueError, IndexError):
        raise OpsError('Malformed Docker inspect result')


def env_dict(items):
    return dict(item.split('=', 1) for item in items or [] if '=' in item)


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.write-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, str(path))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def write_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8'))


def op_dir(op_id):
    if not isinstance(op_id, str) or not ID.fullmatch(op_id):
        raise OpsError('Invalid operation ID')
    return ROOT / 'operations' / op_id


@contextlib.contextmanager
def lock(path, blocking=True):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise OpsError('Another deployment/environment update is running')
        yield
    finally:
        os.close(fd)


def key(create=True):
    if not create and not (ROOT / 'vault.key').exists():
        raise OpsError('Cloud recovery key is missing; restore the original key')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = ROOT / 'vault.key'
    if not path.exists():
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(base64.b64encode(os.urandom(48)))
        except FileExistsError:
            pass
    if path.stat().st_mode & 0o077:
        raise OpsError('Cloud vault key must have mode 0600')
    return path.read_bytes()


def seal(path, value):
    master = key()
    plain = json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8')
    cipher = run(['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '100000',
                  '-salt', '-pass', 'file:' + str(ROOT / 'vault.key')], plain).stdout
    mac = hmac.new(master, b'wqn-ops-v1\0' + cipher, hashlib.sha256).hexdigest()
    write_json(path, {'version': 1, 'mac': mac, 'cipher': base64.b64encode(cipher).decode('ascii')})


def unseal(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    cipher = base64.b64decode(data['cipher'], validate=True)
    expected = hmac.new(key(create=False), b'wqn-ops-v1\0' + cipher, hashlib.sha256).hexdigest()
    if data.get('version') != 1 or not hmac.compare_digest(expected, data.get('mac', '')):
        raise OpsError('Recovery snapshot authentication failed')
    plain = run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000',
                 '-pass', 'file:' + str(ROOT / 'vault.key')], cipher).stdout
    return json.loads(plain.decode('utf-8'))


def fingerprint(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hmac.new(key(), raw, hashlib.sha256).hexdigest()


def snapshot(service, require_running=False):
    if service not in SERVICES:
        raise OpsError('Unknown service')
    c = inspect(SERVICES[service])
    if require_running and not c.get('State', {}).get('Running'):
        raise OpsError('Service must be running before this operation')
    return {'container': c, 'image': inspect(c['Image'])}


def state_guard(snap):
    c = snap['container']
    # Ignore volatile counters/timestamps; bind approval to identity, env and topology.
    return fingerprint(dict({k: c.get(k) for k in (
        'Id', 'Image', 'Config', 'HostConfig', 'Mounts')}, running=c.get('State', {}).get('Running')))


def image_summary(image):
    labels = image.get('Config', {}).get('Labels') or {}
    hints = set()
    for tag in image.get('RepoTags') or []:
        match = re.search(r'-([a-f0-9]{7,40})(?:-rt)?$', tag)
        if match:
            hints.add(match[1])
    return {'image_id': image.get('Id'), 'digests': image.get('RepoDigests') or [],
            'tags': image.get('RepoTags') or [], 'created_at': image.get('Created'),
            'revision': labels.get('org.opencontainers.image.revision'),
            'revision_hint': next(iter(hints)) if len(hints) == 1 else None}


def summarize(snap, service):
    c = snap['container']
    state = c.get('State', {})
    host = c.get('HostConfig', {})
    try:
        ensure_supported(snap)
        adapter = {'supported': True}
    except OpsError as exc:
        adapter = {'supported': False, 'reason': str(exc)}
    return {'service': service, 'name': SERVICES[service], 'container_id': c['Id'],
            'image_ref': c['Config']['Image'], 'image': image_summary(snap['image']),
            'created_at': c.get('Created'), 'started_at': state.get('StartedAt'),
            'running': state.get('Running'), 'health': state.get('Health', {}).get('Status'),
            'restart_count': c.get('RestartCount', 0), 'ports': host.get('PortBindings'),
            'network': host.get('NetworkMode'), 'env_keys': sorted(env_dict(c['Config'].get('Env'))),
            'adapter': adapter}


def safe_text(value, env=None):
    text = str(value)
    for name, secret in (env or {}).items():
        if SECRET.search(name) and len(secret) >= 4:
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'(?i)(Bearer\s+|Basic\s+)[A-Za-z0-9_+/=.-]+', r'\1[redacted]', text)
    text = re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@', r'\1[redacted]@', text)
    text = re.sub(r'(?i)((?:api[_-]?key|password|secret|token)["\s:=]+)[^\s,;"}]+', r'\1[redacted]', text)
    return ''.join(ch for ch in text if ch in '\n\t' or ord(ch) >= 32).replace('\x7f', '')


def log_chunk(service, since=None, tail=250):
    if service not in SERVICES:
        raise OpsError('Unknown service')
    args = ['docker', 'logs', '--timestamps', '--tail', str(min(max(int(tail), 1), 2000))]
    if since:
        if not isinstance(since, str) or not re.fullmatch(r'[0-9TZ:+.\-hms]+', since):
            raise OpsError('Invalid log time')
        args += ['--since', since]
    args.append(SERVICES[service])
    p = run(args, timeout=15, check=False)
    if p.returncode:
        raise OpsError('Logs are unavailable for this container/logging driver')
    c = inspect(SERVICES[service], required=False)
    env = env_dict(c['Config'].get('Env')) if c else {}
    return safe_text((p.stdout + p.stderr)[-2 * 1024 * 1024:].decode('utf-8', 'replace'), env)


def record(op_id):
    path = op_dir(op_id) / 'record.json'
    if not path.exists():
        raise OpsError('Operation not found')
    return json.loads(path.read_text(encoding='utf-8'))


def update(op_id, **fields):
    with lock(op_dir(op_id) / '.record.lock'):
        data = record(op_id)
        data.update(fields)
        data['updated_at'] = now()
        write_json(op_dir(op_id) / 'record.json', data)
        return data


def event(op_id, name, status='running', detail=None):
    with lock(op_dir(op_id) / '.record.lock'):
        data = record(op_id)
        item = {'time': now(), 'step': name, 'status': status}
        if detail is not None:
            item['detail'] = safe_text(detail)[:1000]
        data.setdefault('events', []).append(item)
        data['updated_at'] = now()
        write_json(op_dir(op_id) / 'record.json', data)


def ensure_supported(snap):
    c = snap['container']
    h = c['HostConfig']
    expected_network = PREFIX + '-runtime'
    checks = {
        'mounts': not c.get('Mounts'),
        'network': h.get('NetworkMode') == expected_network,
        'additional networks': len(c.get('NetworkSettings', {}).get('Networks') or {}) <= 1,
        'static IP': not any(n.get('IPAMConfig') for n in (c.get('NetworkSettings', {}).get('Networks') or {}).values()),
        'automatic removal': not h.get('AutoRemove'),
        'automatic ports': not h.get('PublishAllPorts') and not any(
            p.get('HostPort') in ('', '0') for ports in (h.get('PortBindings') or {}).values() for p in ports or []),
        'container runtime': h.get('Runtime', '') in ('', 'runc'),
        'custom healthcheck': c['Config'].get('Healthcheck') == snap['image']['Config'].get('Healthcheck'),
        'privileged': not h.get('Privileged'),
        'devices': not h.get('Devices') and not h.get('DeviceRequests'),
        'extra hosts': not h.get('ExtraHosts'),
        'volumes-from': not h.get('VolumesFrom'),
        'capabilities': not h.get('CapAdd'),
        'links': not h.get('Links'),
        'custom DNS': not h.get('Dns') and not h.get('DnsSearch') and not h.get('DnsOptions'),
        'host namespace': not h.get('PidMode') and h.get('IpcMode', '') in ('', 'private'),
        'resource overrides': not any(h.get(k) for k in (
            'CpuShares', 'CpuPeriod', 'CpuQuota', 'CpusetCpus', 'CpusetMems',
            'MemoryReservation', 'OomKillDisable', 'Ulimits', 'Tmpfs', 'GroupAdd',
            'UsernsMode', 'CgroupParent', 'UTSMode', 'Init', 'Sysctls',
            'VolumeDriver', 'StorageOpt', 'BlkioWeight', 'BlkioDeviceReadBps',
            'BlkioDeviceWriteBps', 'DeviceCgroupRules')),
    }
    bad = [name for name, valid in checks.items() if not valid]
    if bad:
        raise OpsError('Container settings require a custom adapter: ' + ', '.join(bad))


def validate_env(values):
    if not isinstance(values, dict) or len(values) > 300:
        raise OpsError('Invalid env payload')
    for k, v in values.items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) or not isinstance(v, str):
            raise OpsError('Invalid env entry')
        if any(ch in v for ch in ('\0', '\r', '\n')) or len(v) > 65536:
            raise OpsError('Invalid env value for ' + k)


def validate_image(ref):
    if not isinstance(ref, str) or not re.fullmatch(
            r'[A-Za-z0-9][A-Za-z0-9._:/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})', ref):
        raise OpsError('Image must use a version tag or SHA256 digest')
    if ref.endswith(':latest'):
        raise OpsError('Use a retained unique version tag instead of latest')


def repository(ref):
    return re.sub(r':[^/]+$', '', ref.split('@')[0])


def create(req):
    kind = req.get('kind')
    if kind not in ('env', 'deploy', 'rollback', 'build', 'baseline'):
        raise OpsError('Unknown operation kind')
    services = req.get('services', ['app'])
    if not isinstance(services, list) or not services or len(set(services)) != len(services):
        raise OpsError('Invalid services')
    snaps = {}
    for service in services:
        snaps[service] = snapshot(service, require_running=kind == 'env')
        ensure_supported(snaps[service])
    if kind == 'deploy' and req.get('build_id'):
        parent = record(req['build_id'])
        if parent['kind'] != 'build' or parent['status'] != 'pushed':
            raise OpsError('Build operation has no verified push receipt')
        guards = unseal(op_dir(parent['id']) / 'guards.enc')
        frozen = unseal(op_dir(parent['id']) / 'desired.enc')
        if parent.get('source', {}).get('sha') != req.get('source', {}).get('sha'):
            raise OpsError('Deployment source differs from the reviewed build')
        for service in services:
            if service not in guards or state_guard(snaps[service]) != guards[service]:
                raise OpsError('Cloud state changed during build; review a fresh deployment plan')
            if frozen[service]['env'] != req.get('env', {}).get(service):
                raise OpsError('Deployment env differs from the reviewed build')
            artifact = parent['images'][service]
            expected = repository(artifact['ref']) + '@' + artifact['digest']
            if req.get('images', {}).get(service) != expected:
                raise OpsError('Deployment image differs from the push receipt')
    op_id = uuid.uuid4().hex
    directory = op_dir(op_id)
    directory.mkdir(mode=0o700, parents=True)
    source = req.get('source') or {}
    # Only explicitly public metadata is accepted into public records.
    public_source = {k: source.get(k) for k in ('branch', 'sha', 'author_time', 'commit_time',
                      'commits', 'omissions', 'checked_at', 'untracked_count', 'release_baseline', 'repository', 'build_engine')}
    if kind == 'baseline':
        data = {'version': VERSION, 'id': op_id, 'kind': kind, 'status': 'verified',
                'created_at': now(), 'updated_at': now(), 'finished_at': now(),
                'services': services, 'source': {'branch': '云端现场基线', 'sha': None},
                'images': {s: dict(image_summary(v['image']), ref=v['container']['Config']['Image']) for s, v in snaps.items()},
                'before': {s: summarize(v, s) for s, v in snaps.items()},
                'after': {s: summarize(v, s) for s, v in snaps.items()}, 'changes': [],
                'events': [{'time': now(), 'step': 'capture_running_state', 'status': 'passed'}],
                'observed_only': True, 'database_compatibility': 'operator_review_required'}
        seal(directory / 'before.enc', snaps)
        seal(directory / 'after.enc', snaps)
        write_json(directory / 'record.json', data)
        return data
    desired = {}
    changes = []
    target_record = None
    if kind == 'rollback':
        target_record = record(req.get('target_id'))
        if target_record.get('status') != 'verified':
            raise OpsError('Choose a verified operation as rollback target')
        saved = unseal(op_dir(target_record['id']) / 'after.enc')
        for service in services:
            if service not in saved:
                raise OpsError('Target has no snapshot for ' + service)
            ensure_supported(saved[service])
            old = saved[service]['container']
            saved_ref = target_record.get('images', {}).get(service, {}).get('ref')
            if not saved_ref or '/' not in saved_ref:
                image_refs = saved[service]['image'].get('RepoDigests') or saved[service]['image'].get('RepoTags') or []
                saved_ref = image_refs[0] if image_refs else old['Config']['Image']
            desired[service] = {'image': saved_ref, 'image_id': old['Image'],
                                'env': env_dict(old['Config'].get('Env')), 'template': saved[service]}
    else:
        for service in services:
            values = req.get('env', {}).get(service, {})
            validate_env(values)
            if kind == 'env' and service == 'app':
                before_env = env_dict(snaps[service]['container']['Config'].get('Env'))
                image_env = env_dict(snaps[service]['image']['Config'].get('Env'))
                compiled = {'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY',
                            'WQN_SUPABASE_EXPECTED_HOST', 'WQN_ALLOW_HTTP_SUPABASE_ORIGIN', 'SITE_URL'}
                rebuild = sorted(k for k, v in values.items()
                                 if ((k in compiled and v != image_env.get(k, '')) or
                                     (k.startswith('NEXT_PUBLIC_') and v != before_env.get(k))))
                if rebuild:
                    raise OpsError('Build-time variables changed; publish a new image: ' + ', '.join(rebuild))
                shared = [k for k in ('WQN_REALTIME_PROXY_SECRET', 'SUPABASE_SECRET_KEY')
                          if k in values and values[k] != before_env.get(k)]
                if shared and inspect(SERVICES['realtime'], required=False):
                    raise OpsError('Shared App/Realtime credentials changed; update both services together: ' + ', '.join(shared))
            image = req.get('images', {}).get(service)
            if kind in ('deploy', 'build'):
                validate_image(image)
                # Prevent accidental cross-registry replacement through the console.
                old_ref = snaps[service]['container']['Config']['Image']
                old_repo = repository(old_ref)
                new_repo = repository(image)
                if '/' in old_repo and old_repo != new_repo:
                    raise OpsError('Target image repository differs from running ' + service)
            desired[service] = {'image': image or snaps[service]['container']['Config']['Image'],
                                'image_id': snaps[service]['container']['Image'] if kind == 'env' else None,
                                'env': values, 'template': snaps[service]}
    for service, value in desired.items():
        before = env_dict(snaps[service]['container']['Config'].get('Env'))
        defaults = env_dict(snaps[service]['image']['Config'].get('Env'))
        after = dict(defaults, **value['env']) if kind == 'env' else value['env']
        for name in sorted(set(before) | set(after)):
            if name == 'HOSTNAME' or before.get(name) == after.get(name):
                continue
            changes.append({'service': service, 'key': name,
                            'change': 'add' if name not in before else ('remove' if name not in after else 'change')})
    data = {'version': VERSION, 'id': op_id, 'kind': kind, 'status': 'planned',
            'created_at': now(), 'updated_at': now(), 'services': services,
            'source': public_source, 'target_id': req.get('target_id'),
            'build_id': req.get('build_id'),
            'images': {s: {'ref': d['image'], 'image_id': d['image_id']} for s, d in desired.items()},
            'before': {s: summarize(v, s) for s, v in snaps.items()},
            'changes': changes, 'events': [], 'database_compatibility': 'operator_review_required'}
    data['status'] = 'preparing'
    write_json(directory / 'record.json', data)
    seal(directory / 'before.enc', snaps)
    seal(directory / 'desired.enc', desired)
    seal(directory / 'guards.enc', {s: state_guard(v) for s, v in snaps.items()})
    if '_WQN_SOURCE' in globals():
        atomic(directory / 'worker.py', globals()['_WQN_SOURCE'].encode('utf-8'), 0o700)
    data['status'] = 'no_changes' if kind == 'env' and not changes else 'planned'
    write_json(directory / 'record.json', data)
    return data


def append_log(op_id, text, secrets_map=None):
    path = op_dir(op_id) / 'execution.log'
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(safe_text(text, secrets_map)[-65536:])


def execute(op_id, args, env=None, timeout=180):
    p = run(args, timeout=timeout, check=False)
    append_log(op_id, (p.stdout + p.stderr).decode('utf-8', 'replace'), env)
    if p.returncode:
        raise OpsError('Execution failed: ' + ' '.join(args[:2]))
    return p.stdout.decode('utf-8', 'replace').strip()


def run_args(service, desired, env_file):
    snap = desired['template']
    ensure_supported(snap)
    c = snap['container']
    h = c['HostConfig']
    config = c['Config']
    args = ['docker', 'run', '-d', '--name', SERVICES[service], '--pull', 'never',
            '--network', h['NetworkMode'], '--env-file', str(env_file)]
    restart = h.get('RestartPolicy', {})
    name = restart.get('Name', 'no')
    if name == 'on-failure' and restart.get('MaximumRetryCount'):
        name += ':' + str(restart['MaximumRetryCount'])
    args += ['--restart', name]
    for alias in c.get('NetworkSettings', {}).get('Networks', {}).get(h['NetworkMode'], {}).get('Aliases') or []:
        if alias not in (c['Id'], c['Id'][:12], c.get('Name', '').lstrip('/')):
            args += ['--network-alias', alias]
    for port, bindings in (h.get('PortBindings') or {}).items():
        for binding in bindings or []:
            ip = binding.get('HostIp', '')
            if ':' in ip:
                ip = '[' + ip + ']'
            args += ['-p', (ip + ':' if ip else '') + binding['HostPort'] + ':' + port]
    if config.get('User'):
        args += ['--user', config['User']]
    if config.get('WorkingDir'):
        args += ['--workdir', config['WorkingDir']]
    if h.get('ReadonlyRootfs'):
        args += ['--read-only']
    for item in h.get('CapDrop') or []:
        args += ['--cap-drop', item]
    for item in h.get('SecurityOpt') or []:
        args += ['--security-opt', item]
    for field, option in (('Memory', '--memory'), ('MemorySwap', '--memory-swap'),
                           ('NanoCpus', '--cpus'), ('PidsLimit', '--pids-limit'),
                           ('ShmSize', '--shm-size')):
        if h.get(field) and (h[field] > 0 or (field == 'MemorySwap' and h[field] == -1)):
            args += [option, str(h[field] / 1e9 if field == 'NanoCpus' else h[field])]
    log = h.get('LogConfig', {})
    if log.get('Type'):
        args += ['--log-driver', log['Type']]
        for k, v in (log.get('Config') or {}).items():
            args += ['--log-opt', k + '=' + v]
    # Deployments use the target image's entrypoint/cmd; env updates and rollback
    # preserve the previous container's exact overrides.
    if desired.get('preserve_command', True):
        entry = config.get('Entrypoint') or []
        if entry:
            args += ['--entrypoint', entry[0]]
        args.append(desired['image_id'])
        args.extend(entry[1:] + (config.get('Cmd') or []))
    else:
        args.append(desired['image_id'])
    return args


def verify_env(service, desired):
    c = inspect(SERVICES[service])
    if c['Image'] != desired['image_id']:
        raise OpsError('Image identity verification failed for ' + service)
    expected = env_dict(inspect(desired['image_id'])['Config'].get('Env'))
    expected.update(desired['env'])
    actual = env_dict(c['Config'].get('Env'))
    bad = sorted(k for k in set(expected) | set(actual)
                 if k != 'HOSTNAME' and expected.get(k) != actual.get(k))
    if bad:
        raise OpsError('Environment mismatch for ' + service + ': ' + ', '.join(bad))


def readiness(service, attempts=20):
    for _ in range(attempts):
        c = inspect(SERVICES[service])
        if not c.get('State', {}).get('Running'):
            raise OpsError(service + ' stopped during startup')
        port = 3000 if service == 'app' else 8080
        path = '/' if service == 'app' else '/health'
        # Probe this exact container, not a proxy or another process on host ports.
        js = ("fetch('http://127.0.0.1:%d%s',{signal:AbortSignal.timeout(2500)})"
              ".then(r=>process.exit(r.status>=200&&r.status<400?0:1)).catch(()=>process.exit(1))") % (port, path)
        p = run(['docker', 'exec', SERVICES[service], 'node', '-e', js], timeout=5, check=False)
        if p.returncode == 0:
            return
        time.sleep(2)
    raise OpsError('HTTP readiness failed for ' + service)


def install_env(service, values):
    validate_env(values)
    path = HOME_DIR / ('.env.wqn-app' if service == 'app' else '.env.wqn-realtime')
    atomic(path, ''.join(k + '=' + v + '\n' for k, v in sorted(values.items())).encode('utf-8'))


def restore_old(op_id, old, renamed, stopped):
    errors = []
    for service in reversed(list(old)):
        name = SERVICES[service]
        try:
            if service in renamed:
                run(['docker', 'rm', '-f', name], check=False)
                execute(op_id, ['docker', 'rename', renamed[service], name])
            if service in stopped:
                execute(op_id, ['docker', 'start', name])
                if inspect(name)['Id'] != old[service]['container']['Id']:
                    raise OpsError('Recovered container identity differs from the saved state')
                readiness(service)
            install_env(service, env_dict(old[service]['container']['Config'].get('Env')))
        except OpsError:
            errors.append(service)
    if errors:
        raise OpsError('Automatic recovery needs attention: ' + ', '.join(errors))


def _worker_locked(op_id):
    data = record(op_id)
    old = unseal(op_dir(op_id) / 'before.enc')
    desired = unseal(op_dir(op_id) / 'desired.enc')
    renamed, stopped = {}, set()
    try:
        guards = unseal(op_dir(op_id) / 'guards.enc')
        for service in data['services']:
            if state_guard(snapshot(service)) != guards[service]:
                raise OpsError('Cloud state changed after review; create a fresh plan')
        update(op_id, status='running', started_at=now(), pid=os.getpid())
        event(op_id, 'validate_state', 'passed')
        # Pull every requested image before stopping any container.
        for service, d in desired.items():
            if not d['image_id']:
                execute(op_id, ['docker', 'pull', d['image']], timeout=300)
                d['image_id'] = inspect(d['image'])['Id']
                d['preserve_command'] = False
            elif not inspect(d['image_id'], required=False):
                execute(op_id, ['docker', 'pull', d['image']], timeout=300)
                if inspect(d['image'])['Id'] != d['image_id']:
                    raise OpsError('Rollback version tag no longer matches saved image content')
        event(op_id, 'images_ready', 'passed')
        seal(op_dir(op_id) / 'resolved.enc', desired)
        update(op_id, images={s: dict(image_summary(inspect(d['image_id'])), ref=d['image'])
                             for s, d in desired.items()})
        for service, d in desired.items():
            try:
                atomic(op_dir(op_id) / (service + '.before.log'), log_chunk(service).encode('utf-8'))
            except OpsError:
                event(op_id, 'archive_logs_' + service, 'unavailable')
            values = d['env']
            env_file = op_dir(op_id) / (service + '.runtime.tmp')
            atomic(env_file, ''.join(k + '=' + v + '\n' for k, v in sorted(values.items())).encode('utf-8'))
            try:
                stopped.add(service)
                execute(op_id, ['docker', 'stop', '-t', '15', SERVICES[service]])
                backup_name = SERVICES[service] + '.ops-' + op_id[:12]
                execute(op_id, ['docker', 'rename', SERVICES[service], backup_name])
                renamed[service] = backup_name
                execute(op_id, run_args(service, d, env_file), values)
                event(op_id, 'start_' + service, 'passed')
                verify_env(service, d)
                readiness(service)
                install_env(service, values)
                event(op_id, 'verify_' + service, 'passed')
            finally:
                if env_file.exists():
                    env_file.unlink()
        after = {s: snapshot(s) for s in data['services']}
        seal(op_dir(op_id) / 'after.enc', after)
        update(op_id, status='verified', finished_at=now(),
               after={s: summarize(v, s) for s, v in after.items()})
        # Keep tagged backups as rollback anchors; no image pruning here.
        for service, backup in renamed.items():
            event(op_id, 'retained_' + service, 'passed', backup)
    except Exception as exc:
        message = str(exc) if isinstance(exc, OpsError) else 'Worker failed; inspect operation events'
        event(op_id, 'execute', 'failed', message)
        if stopped:
            try:
                restore_old(op_id, old, renamed, stopped)
                update(op_id, status='rolled_back', recovery='verified', error=message, finished_at=now())
            except Exception:
                update(op_id, status='needs_attention', recovery='unverified', error=message, finished_at=now())
        else:
            update(op_id, status='failed', error=message, finished_at=now())


def worker(op_id):
    try:
        # Keep the mutation lock through automatic recovery, too.
        with lock(ROOT / '.mutation.lock', blocking=False):
            _worker_locked(op_id)
    except OpsError as exc:
        update(op_id, status='failed', error=str(exc), finished_at=now())


def apply(req):
    op_id = req.get('id')
    directory = op_dir(op_id)
    with lock(directory / '.apply.lock', blocking=False):
        data = record(op_id)
        if data['status'] != 'planned':
            raise OpsError('This plan has already been used; query its operation ID')
        if data['kind'] == 'build':
            raise OpsError('Build records are finalized by the local build coordinator')
        if data['kind'] == 'rollback' and req.get('compatibility_reviewed') is not True:
            raise OpsError('Review database/config compatibility before rollback')
        path = directory / 'worker.py'
        if not path.exists():
            raise OpsError('Worker source missing')
        update(op_id, status='queued')
        log = os.open(str(directory / 'worker.log'), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            p = subprocess.Popen([sys.executable, str(path), '--worker', op_id],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, close_fds=True)
            update(op_id, pid=p.pid)
        except OSError:
            update(op_id, status='failed', error='Cannot start cloud worker', finished_at=now())
            raise OpsError('Cannot start cloud worker')
        finally:
            os.close(log)
    return record(op_id)


def dispatch(req):
    action = req.get('action')
    if action == 'status':
        items = []
        latest, snapshots = {}, {}
        directory = ROOT / 'operations'
        if directory.exists():
            records = []
            for path in directory.glob('*/record.json'):
                try:
                    data = json.loads(path.read_text(encoding='utf-8'))
                    if data.get('status') == 'verified':
                        records.append(data)
                except (OSError, ValueError):
                    continue
            for data in sorted(records, key=lambda r: r['created_at'], reverse=True):
                for service in data.get('services', []):
                    latest.setdefault(service, data)
        for service, name in SERVICES.items():
            c = inspect(name, required=False)
            if c:
                current = {'container': c, 'image': inspect(c['Image'])}
                item = summarize(current, service)
                item['drift'] = {'status': 'untracked'}
                if service in latest:
                    prior = latest[service]
                    try:
                        if prior['id'] not in snapshots:
                            snapshots[prior['id']] = unseal(op_dir(prior['id']) / 'after.enc')
                        same = state_guard(current) == state_guard(snapshots[prior['id']][service])
                        item['drift'] = {'status': 'matches' if same else 'changed', 'operation_id': prior['id']}
                    except (OpsError, OSError, ValueError, KeyError):
                        item['drift'] = {'status': 'unverified', 'operation_id': prior['id']}
                items.append(item)
        return {'checked_at': now(), 'services': items, 'history_initialized': (ROOT / 'operations').exists()}
    if action == 'history':
        items = []
        directory = ROOT / 'operations'
        if directory.exists():
            for path in directory.glob('*/record.json'):
                try:
                    items.append(json.loads(path.read_text(encoding='utf-8')))
                except (OSError, ValueError):
                    continue
        return {'checked_at': now(), 'operations': sorted(items, key=lambda r: r['created_at'], reverse=True)[:200]}
    if action == 'image_probe':
        data = record(req.get('id'))
        service = req.get('service')
        image = data.get('images', {}).get(service)
        if not image:
            raise OpsError('No image recorded for this service')
        ref = image.get('ref')
        validate_image(ref)
        p = run(['docker', 'manifest', 'inspect', '--verbose', ref], timeout=30, check=False)
        if p.returncode:
            return {'available': False, 'checked_at': now(), 'ref': ref,
                    'reason': 'Registry/auth/network check failed; availability is unverified'}
        try:
            manifest = json.loads(p.stdout.decode('utf-8'))
            if isinstance(manifest, list):
                raise ValueError()
            digest = manifest['Descriptor']['digest']
            expected = image.get('digest')
            if not expected:
                expected = next((d.split('@', 1)[1] for d in image.get('digests', []) if '@' in d), None)
            return {'available': True, 'matches': digest == expected if expected else None,
                    'digest': digest, 'ref': ref, 'checked_at': now()}
        except (ValueError, KeyError, TypeError):
            raise OpsError('Unsupported registry manifest response')
    if action == 'operation':
        data = record(req.get('id'))
        # A dead worker after SIGKILL/host reboot is an uncertain result, never
        # an invitation to repeat a mutation automatically.
        if data['status'] in ('running', 'queued') and data.get('pid'):
            try:
                os.kill(data['pid'], 0)
            except ProcessLookupError:
                data = update(data['id'], status='unknown', error='Worker ended without a final receipt; inspect cloud state')
        path = op_dir(data['id']) / 'execution.log'
        data['log'] = path.read_text(encoding='utf-8')[-100000:] if path.exists() else ''
        return data
    if action == 'logs':
        source = req.get('source', 'app')
        if source in SERVICES:
            text = log_chunk(source, req.get('since'), req.get('tail', 250))
        elif source in ('nginx-access', 'nginx-error', 'docker-daemon'):
            if source == 'docker-daemon':
                p = run(['journalctl', '-u', 'docker', '-n', '300', '--no-pager', '-o', 'short-iso'], check=False)
            else:
                path = '/var/log/nginx/' + ('access.log' if source == 'nginx-access' else 'error.log')
                p = run(['tail', '-n', '300', path], check=False)
            if p.returncode:
                raise OpsError('Requested system log is unavailable')
            env = {}
            for name in SERVICES.values():
                c = inspect(name, required=False)
                if c:
                    env.update(env_dict(c['Config'].get('Env')))
            text = safe_text((p.stdout + p.stderr)[-2 * 1024 * 1024:].decode('utf-8', 'replace'), env)
        else:
            raise OpsError('Unknown log source')
        return {'checked_at': now(), 'source': source, 'text': text}
    if action == 'preview_env':
        service = req.get('service', 'app')
        snap = snapshot(service)
        proposed = req.get('env', {})
        validate_env(proposed)
        before = env_dict(snap['container']['Config'].get('Env'))
        after = env_dict(snap['image']['Config'].get('Env'))
        after.update(proposed)
        return {'checked_at': now(), 'service': service,
                'changes': [{'key': k, 'change': 'add' if k not in before else ('remove' if k not in after else 'change')}
                            for k in sorted(set(before) | set(after))
                            if k != 'HOSTNAME' and before.get(k) != after.get(k)]}
    if action == 'prepare':
        return create(req)
    if action == 'apply':
        return apply(req)
    if action == 'event':
        if req.get('step') == 'build_push' and req.get('status') == 'running':
            update(req.get('id'), status='building')
        event(req.get('id'), req.get('step', 'build'), req.get('status', 'running'), req.get('detail'))
        return record(req['id'])
    if action == 'append_log':
        text = req.get('text')
        if not isinstance(text, str) or len(text) > 65536:
            raise OpsError('Invalid log chunk')
        record(req.get('id'))
        append_log(req['id'], text)
        return {'saved': True}
    if action == 'finish_build':
        data = record(req.get('id'))
        if data['kind'] != 'build' or data['status'] not in ('planned', 'building'):
            raise OpsError('Not an active build operation')
        return update(data['id'], status='pushed' if req.get('success') else 'failed', finished_at=now(),
                      images=req.get('images', data['images']))
    if action == 'defer':
        value = req.get('decision')
        if not isinstance(value, dict) or not re.fullmatch(r'[a-f0-9]{64}', value.get('fingerprint', '')):
            raise OpsError('Invalid deferral')
        reason = value.get('reason', '').strip()
        if not reason or len(reason) > 500:
            raise OpsError('Provide a short deferral reason')
        path = ROOT / 'decisions.json'
        with lock(ROOT / '.decisions.lock'):
            data = json.loads(path.read_text()) if path.exists() else {}
            previous = data.get(value['fingerprint'])
            history = ([{k: previous.get(k) for k in ('reason', 'time', 'branch')}] + previous.get('history', [])
                       if previous else [])
            data[value['fingerprint']] = {'reason': reason, 'time': now(), 'branch': str(value.get('branch', ''))[:200],
                                          'history': history,
                                          'commits': [{k: c.get(k) for k in ('sha', 'subject', 'commit_time', 'patch_id', 'variants')}
                                                      for c in value.get('missing', [])]}
            write_json(path, data)
        return data
    if action == 'decisions':
        path = ROOT / 'decisions.json'
        return json.loads(path.read_text()) if path.exists() else {}
    raise OpsError('Unknown operation')


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(sys.argv[2])
        return
    try:
        result = dispatch(json.load(sys.stdin))
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as exc:
        message = str(exc) if isinstance(exc, OpsError) else 'Cloud operation failed; no sensitive output returned'
        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
