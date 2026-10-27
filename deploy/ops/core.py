"""Local Git inspection, ephemeral build coordination, and SSH transport."""
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import subprocess
import tarfile
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
REMOTE = Path(__file__).with_name('remote.py')
EXTRA_APP_KEYS = {
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'SENTRY_DSN',
    'WQN_ESP32_AI_STREAMING_MODE', 'WQN_ESP32_AI_STREAM_TIMEOUT_MS',
    'WQN_ESP32_AI_STREAM_ASR_POLL_INTERVAL_MS', 'WQN_ESP32_AI_STREAM_MAX_TOOLS_PER_TURN',
    'WQN_ESP32_AI_STREAM_REQUEST_CACHE_HOURS', 'WQN_AI_STREAMING_ENABLED',
    'WQN_OPENCODE_PROMPT_TIMEOUT_MS', 'WQN_OPENCODE_PENDING_POLL_MS',
}
FORBIDDEN = {'ACR_PASSWORD', 'ACR_USERNAME', 'TARGET_DATABASE_URL',
             'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', 'SUPABASE_SERVICE_ROLE_KEY'}
PLACEHOLDERS = {
    'sb_publishable_replace_me', 'sb_secret_replace_me', 'your_anon_key_here',
    'your_service_role_key_here', 'your_dashscope_api_key_here',
    'replace_with_long_random_secret', 'replace_with_32_byte_base64_key',
    'replace_with_stepfun_api_key', 'https://data.example.invalid', 'https://your-domain.com',
}


class OpsError(Exception):
    pass


class TransportError(OpsError):
    """No authoritative SSH response; do not manufacture a failed receipt."""


def now():
    return datetime.now(timezone.utc).isoformat()


def command(args, cwd=None, data=None, timeout=30, check=True, env=None):
    try:
        p = subprocess.run(args, cwd=str(cwd or REPO), input=data,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise OpsError('命令不可用或超时：' + args[0]) from exc
    if check and p.returncode:
        raise OpsError('命令执行失败：' + ' '.join(args[:2]))
    return p


def git(*args, repo=None, check=True):
    return command(['git', *args], cwd=repo, check=check).stdout.decode('utf-8', 'replace').strip()


def resolve(ref='HEAD', repo=None):
    if not isinstance(ref, str) or ref.startswith('-') or any(c in ref for c in '\0\r\n'):
        raise OpsError('无效的 Git 引用')
    value = git('rev-parse', '--verify', ref + '^{commit}', repo=repo)
    if not re.fullmatch(r'[a-f0-9]{40,64}', value):
        raise OpsError('无法解析候选提交')
    return value


def commits(ref='HEAD', limit=10, repo=None):
    fmt = '%H%x00%P%x00%aI%x00%cI%x00%an%x00%s'
    raw = git('log', '--first-parent', '-' + str(limit), '--format=' + fmt, resolve(ref, repo), repo=repo)
    rows = []
    for line in raw.splitlines():
        parts = line.split('\0', 5)
        if len(parts) == 6:
            sha, parents, author_time, commit_time, author, subject = parts
            rows.append(dict(sha=sha, parents=parents.split(), author_time=author_time,
                             commit_time=commit_time, author=author, subject=subject))
    return rows


def context(sha, branch, repo=None):
    target = commits(sha, 1, repo)[0]
    before = commits(target['parents'][0], 3, repo) if target['parents'] else []
    following = git('rev-list', '--ancestry-path', '--reverse', sha + '..' + branch, repo=repo).splitlines()[:3]
    return {'before': list(reversed(before)), 'target': target,
            'after': [commits(s, 1, repo)[0] for s in following]}


def repository_id(url):
    """Compare remote identities without exposing credentials embedded in URLs."""
    from urllib.parse import urlsplit
    if '://' in url:
        parsed = urlsplit(url)
        host, path = parsed.hostname or '', parsed.path
    else:
        match = re.fullmatch(r'(?:[^@/]+@)?([^:/]+):(.+)', url)
        if not match:
            return None
        host, path = match.groups()
    return (host.lower() + '/' + path.strip('/').removesuffix('.git')).lower()


def review_decisions(report, saved):
    """Keep reasons recorded by the SHA-based scanner, without mutating the archive."""
    result = dict(saved)
    for row in report['omissions']:
        keys = [row['fingerprint'], *row.get('legacy_fingerprints', [])]
        matches = [saved[k] for k in keys if k in saved]
        if matches:
            history = [reason for match in matches for reason in [match, *match.get('history', [])]]
            result[row['fingerprint']] = dict(matches[0], reason_history=history)
    return result


def review_refs(sha, branches, repo):
    primary_remote = 'origin'
    origin = repository_id(git('config', '--get', 'remote.origin.url', repo=repo, check=False))
    remotes = {name: repository_id(git('config', '--get', 'remote.' + name + '.url', repo=repo, check=False))
               for name in git('remote', repo=repo).splitlines()}
    references, logical = [], {}
    for b in branches:
        name = b['name']
        if b['remote']:
            remote, _, name = name.partition('/')
            if remote != primary_remote and (not origin or remotes.get(remote) != origin):
                references.append(dict(b, branch=b['name'], aliases=[b['name']], missing=[],
                                       reason='外部仓库引用；不作为本仓库的发布待办', requires_review=False))
                continue
        if name.startswith(('backup/', 'dependabot/')):
            references.append(dict(b, branch=b['name'], aliases=[b['name']], missing=[],
                                   reason='备份或依赖机器人分支；在参考区单独查看', requires_review=False))
            continue
        logical.setdefault(name, []).append(b)

    release_ref = 'refs/remotes/origin/release/note-baseline-prod'
    release_sha = git('rev-parse', '--verify', release_ref + '^{commit}', repo=repo, check=False)
    release = dict(commits(release_sha, 1, repo)[0], branch=release_ref) if release_sha else None
    dirty_raw = command(['git', 'status', '--porcelain', '-z', '-uall'], cwd=repo).stdout
    # Include both sides of a rename. This is an annotation, never inclusion evidence.
    dirty = set()
    chunks = iter(dirty_raw.split(b'\0'))
    for chunk in chunks:
        if chunk:
            dirty.add(os.fsdecode(chunk[3:]))
            if b'R' in chunk[:2] or b'C' in chunk[:2]:
                dirty.add(os.fsdecode(next(chunks, b'')))
    trees = {}
    def tree(target):
        if target not in trees:
            entries = command(['git', 'ls-tree', '-r', '-z', target], cwd=repo).stdout
            trees[target] = {}
            for entry in entries.split(b'\0'):
                if entry:
                    meta, path = entry.split(b'\t', 1)
                    mode, _, blob = meta.decode().split()
                    trees[target][os.fsdecode(path)] = (mode, blob)
        return trees[target]

    cache, indices = {}, {}
    with tempfile.TemporaryDirectory(prefix='wqn-git-review-') as temporary:
        def coverage(target, changes, patch):
            target_tree = tree(target)
            expected = {path: None if newmode == '000000' else (newmode, blob)
                        for path, newmode, blob in changes}
            if expected and all(target_tree.get(path) == value for path, value in expected.items()):
                return 'postimages_match'
            if any(value is not None and path not in target_tree for path, value in expected.items()):
                return 'unmatched'
            if not patch:
                return 'unmatched'
            if target not in indices:
                env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / target))
                args = ['git', '-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false']
                command([*args, 'read-tree', target], cwd=repo, env=env)
                indices[target] = (env, args)
            env, args = indices[target]
            p = command([*args, 'apply', '--cached', '--reverse', '--check'], cwd=repo, data=patch, env=env, check=False)
            return 'reverse_patch_matches' if p.returncode == 0 else 'unmatched'

        def detail(commit):
            if commit in cache:
                return cache[commit]
            row = commits(commit, 1, repo)[0]
            raw = command(['git', 'diff-tree', '--root', '--no-commit-id', '--raw', '-r',
                           '--no-renames', '-z', commit], cwd=repo).stdout.split(b'\0')
            changes = []
            for i in range(0, len(raw) - 1, 2):
                fields = raw[i].decode().split()
                changes.append((os.fsdecode(raw[i + 1]), fields[1], fields[3]))
            paths = [p for p, _, _ in changes]
            def path_category(path):
                if path == '.github/dependabot.yml':
                    return 'configuration'
                if path.startswith(('deploy/', '.github/', 'doc/', 'docs/')) or ('/' not in path and path.endswith('.md')):
                    return 'tooling'
                return 'runtime'
            runtime_changes = [c for c in changes if path_category(c[0]) == 'runtime']
            category = ('runtime' if runtime_changes else 'configuration' if paths and
                        all(path_category(p) == 'configuration' for p in paths) else 'tooling')
            reviewed_changes = runtime_changes or changes
            reviewed_paths = [p for p, _, _ in reviewed_changes]
            # A mixed commit's deployment/docs context must not make an already
            # integrated runtime patch appear missing, or duplicate its backport.
            patch = command(['git', 'show', '--format=', '--binary', '--no-ext-diff', '--no-renames', commit,
                             '--', *[':(literal)' + p for p in reviewed_paths]], cwd=repo).stdout
            patch_id = command(['git', 'patch-id', '--stable'], cwd=repo, data=patch).stdout.decode().split()
            row.update(patch_id=patch_id[0] if patch_id else commit, paths=paths, category=category,
                       reviewed_paths=reviewed_paths, coverage=coverage(sha, reviewed_changes, patch),
                       workspace_paths=sorted(dirty.intersection(paths)))
            if release:
                row['release_coverage'] = coverage(release_sha, reviewed_changes, patch)
            cache[commit] = row
            return row

        checked, rows = set(), []
        eligible = {b['sha'] for refs in logical.values() for b in refs}
        for name, aliases in logical.items():
            missing, equivalent, legacy = {}, set(), {}
            variants, source_refs, merges = {}, [], {}
            for b in aliases:
                oid = b['sha']
                if oid not in checked and len(checked) >= 100:
                    continue
                checked.add(oid)
                p = command(['git', 'merge-base', '--is-ancestor', oid, sha], cwd=repo, check=False)
                if p.returncode == 0:
                    b['candidate_relation'] = 'ancestor'
                    continue
                if p.returncode != 1:
                    raise OpsError('提交关系检查失败；可能缺少历史')
                for commit in git('rev-list', '--merges', sha + '..' + oid, repo=repo).splitlines():
                    if commit not in merges:
                        merges[commit] = commits(commit, 1, repo)[0]
                plus = []
                for line in git('cherry', '-v', sha, oid, repo=repo).splitlines():
                    sign, commit, _ = line.split(' ', 2)
                    if sign == '-':
                        equivalent.add(commit)
                        continue
                    plus.append(commit)
                    row = detail(commit)
                    key = row['patch_id']
                    missing.setdefault(key, row)
                    variants.setdefault(key, {})[commit] = {'sha': commit, 'ref': b['ref'], 'branch': b['name']}
                if plus:
                    source_refs.append(b)
                    old_key = hashlib.sha256('\n'.join(sorted(plus)).encode()).hexdigest()
                    legacy[old_key] = {detail(c)['patch_id'] for c in plus}
                b['candidate_relation'] = 'different' if plus else 'equivalent'
            if not missing:
                if merges:
                    primary = next((b for b in aliases if not b['remote']), aliases[0])
                    references.append(dict(primary, branch=name, aliases=[b['name'] for b in aliases],
                                           missing=[], merge_commits=list(merges.values()), requires_review=False,
                                           reason='只有合并历史差异；冲突解决内容需要人工核对，未判定为功能遗漏'))
                continue
            primary = next((b for b in source_refs if not b['remote']), source_refs[0])
            runtime = [c for c in missing.values() if c['category'] == 'runtime' and c['coverage'] == 'unmatched']
            related = [c for c in missing.values() if c not in runtime]
            for c in [*runtime, *related]:
                c = dict(c, variants=list(variants[c['patch_id']].values()))
                # Each group owns its provenance; do not modify the cached commit.
                missing[c['patch_id']] = c
            runtime = [missing[c['patch_id']] for c in runtime]
            related = [missing[c['patch_id']] for c in related]
            fingerprint = hashlib.sha256('\n'.join(sorted(c['patch_id'] for c in runtime)).encode()).hexdigest()
            runtime_ids = {c['patch_id'] for c in runtime}
            rows.append({'branch': name, 'ref': primary['ref'], 'aliases': [b['name'] for b in source_refs],
                         'tips': aliases, 'sha': primary['sha'], 'commit_time': max(b['commit_time'] for b in aliases),
                         'missing': runtime, 'related': related, 'missing_count': len(runtime),
                         'merge_commits': list(merges.values()),
                         'equivalent_count': len(equivalent), 'fingerprint': fingerprint,
                         'legacy_coverage': {k: sorted(ids) for k, ids in legacy.items()},
                         'legacy_fingerprints': sorted(k for k, ids in legacy.items() if runtime_ids <= ids),
                         'requires_review': bool(runtime), 'archived': not runtime})

    groups = {}
    for row in rows:
        if not row['requires_review']:
            references.append(dict(row, missing=row['related'], reason='仅工具或配置差异，或候选内容已有匹配；不计入程序改动核对'))
            continue
        ids = {c['patch_id'] for c in row['missing']}
        overlaps = [k for k, group in groups.items() if ids.intersection(c['patch_id'] for c in group['missing'])]
        for key in overlaps:
            existing = groups.pop(key)
            # Prefer the integration branch, while keeping every original commit/ref.
            if row['branch'].startswith('merge/') and not existing['branch'].startswith('merge/'):
                existing, row = row, existing
            existing['aliases'] = sorted(set(existing['aliases'] + row['aliases']))
            existing['tips'] += row['tips']
            existing['merge_commits'] = list({c['sha']: c for c in [*existing['merge_commits'], *row['merge_commits']]}.values())
            existing['legacy_coverage'].update(row['legacy_coverage'])
            by_id = {c['patch_id']: c for c in existing['missing']}
            for c in row['missing']:
                if c['patch_id'] not in by_id:
                    existing['missing'].append(c)
                    continue
                other = by_id[c['patch_id']]
                seen = {(v['sha'], v['ref']) for v in other['variants']}
                other['variants'] += [v for v in c['variants'] if (v['sha'], v['ref']) not in seen]
            known = {c['patch_id'] for c in existing['related']}
            existing['related'] += [c for c in row['related'] if c['patch_id'] not in known]
            row = existing
        ids = {c['patch_id'] for c in row['missing']}
        row['fingerprint'] = hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest()
        row['missing_count'] = len(ids)
        row['legacy_fingerprints'] = sorted(k for k, covered in row['legacy_coverage'].items() if ids <= set(covered))
        groups[row['fingerprint']] = row
    for row in [*groups.values(), *references]:
        row.pop('legacy_coverage', None)
    return {'omissions': list(groups.values()), 'references': references, 'release_baseline': release,
            'repository': origin, 'primary_remote': primary_remote, 'refs_checked': len(checked), 'refs_total': len(eligible)}


def scan(ref='HEAD', repo=None):
    repo = Path(repo or REPO)
    sha = resolve(ref, repo)
    raw = git('for-each-ref', '--sort=-committerdate',
              '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)',
              'refs/heads', 'refs/remotes', repo=repo)
    branches = []
    for line in raw.splitlines():
        parts = line.split('\0')
        if len(parts) != 3 or parts[0].endswith('/HEAD'):
            continue
        name, oid, stamp = parts
        short = name.removeprefix('refs/heads/').removeprefix('refs/remotes/')
        item = {'ref': name, 'name': short, 'sha': oid, 'commit_time': stamp,
                'remote': name.startswith('refs/remotes/')}
        branches.append(item)
    review = review_refs(sha, branches, repo)
    worktrees = []
    current = {}
    for line in git('worktree', 'list', '--porcelain', repo=repo).splitlines() + ['']:
        if not line:
            if current:
                path = current['path']
                p = command(['git', 'status', '--porcelain', '-uall'], cwd=path, check=False)
                changes = p.stdout.decode('utf-8', 'replace').splitlines()
                current['changes'] = changes[:100]
                current['change_count'] = len(changes)
                current['accessible'] = p.returncode == 0
                worktrees.append(current)
                current = {}
            continue
        key, _, value = line.partition(' ')
        if key == 'worktree':
            current['path'] = value
        elif key in ('HEAD', 'branch'):
            current[key.lower()] = value.removeprefix('refs/heads/')
    timeline = commits(sha, 10, repo)
    branch = ref
    if ref == 'HEAD':
        branch = git('symbolic-ref', '--quiet', '--short', 'HEAD', repo=repo, check=False) or 'HEAD（游离提交）'
    common = Path(git('rev-parse', '--git-common-dir', repo=repo))
    if not common.is_absolute():
        common = repo / common
    fetch = common / 'FETCH_HEAD'
    return {'checked_at': now(), 'candidate': dict(timeline[0], branch=branch),
            'commits': timeline, 'branches': branches, **review,
            'worktrees': worktrees, 'stash_count': len(git('stash', 'list', '--format=%gd', repo=repo).splitlines()),
            'shallow': git('rev-parse', '--is-shallow-repository', repo=repo) == 'true',
            'remote_refs_updated_at': datetime.fromtimestamp(fetch.stat().st_mtime, timezone.utc).isoformat() if fetch.exists() else None}


def source_metadata(report):
    c = report['candidate']
    return {k: c.get(k) for k in ('branch', 'sha', 'author_time', 'commit_time')} | {
        'checked_at': report['checked_at'], 'commits': report['commits'],
        'release_baseline': report.get('release_baseline'), 'repository': report.get('repository'),
        'omissions': [{**{k: row[k] for k in ('branch', 'fingerprint', 'missing_count')},
                       'commits': [{k: c[k] for k in ('sha', 'subject', 'commit_time', 'patch_id', 'variants')}
                                   for c in row.get('missing', [])]} for row in report['omissions']],
        'untracked_count': sum(w['change_count'] for w in report['worktrees'])}


def github_prs(ref='HEAD'):
    identity = repository_id(git('config', '--get', 'remote.origin.url', check=False))
    if not identity or not identity.startswith('github.com/'):
        raise OpsError('origin 不是可识别的 GitHub 仓库')
    repository = identity.removeprefix('github.com/')
    p = command(['gh', 'pr', 'list', '--repo', repository, '--state', 'all', '--limit', '200', '--json',
                 'number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url'], timeout=30, check=False)
    if p.returncode:
        raise OpsError('GitHub 查询失败；请检查 gh 登录与网络')
    rows = json.loads(p.stdout)
    tips = git('for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes/origin').splitlines()
    candidate = resolve(ref)
    for row in rows:
        row['ref_checks'] = []
        head = row['headRefOid']
        if not re.fullmatch(r'[a-f0-9]{40,64}', head or ''):
            continue
        known = command(['git', 'cat-file', '-e', head + '^{commit}'], check=False).returncode == 0
        row['head_ancestor_of_candidate'] = (command(['git', 'merge-base', '--is-ancestor', head, candidate], check=False).returncode == 0
                                              if known else None)
        for line in tips:
            name, tip = line.split('\0')
            if name not in ('refs/heads/' + row['headRefName'], 'refs/remotes/origin/' + row['headRefName']):
                continue
            relation = 'unknown'
            count = None
            if tip == head:
                relation, count = 'same', 0
            elif known and command(['git', 'merge-base', '--is-ancestor', head, tip], check=False).returncode == 0:
                relation = 'followup'
                count = int(git('rev-list', '--count', '--no-merges', head + '..' + tip))
            elif known:
                relation = 'diverged'
            row['ref_checks'].append({'ref': name, 'sha': tip, 'relationship': relation, 'followup_count': count})
    return {'checked_at': now(), 'repository': repository, 'candidate_sha': candidate, 'pull_requests': rows}


def dotenv(path=None, data=None):
    result = {}
    path = Path(path or REPO / 'web/.env.production')
    if data is None and not path.is_file():
        raise OpsError('缺少 web/.env.production')
    text = data.decode('utf-8-sig') if data is not None else path.read_text(encoding='utf-8-sig')
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
        if not match:
            raise OpsError('环境文件第 %d 行格式错误' % number)
        k, v = match.groups()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        else:
            v = re.sub(r'\s+#.*$', '', v).strip()
        if '\0' in v:
            raise OpsError('环境变量含无效字符：' + k)
        result[k] = v
    return result


def policy(ref='HEAD', repo=None):
    sha = resolve(ref, repo)
    text = git('show', sha + ':deploy/release-env-policy.sh', repo=repo)
    arrays = {}
    for name in ('APP_RUNTIME_KEYS', 'REALTIME_RUNTIME_KEYS', 'APP_REQUIRED_RUNTIME_KEYS', 'REALTIME_REQUIRED_RUNTIME_KEYS'):
        match = re.search(r'^' + name + r'=\((.*?)^\)', text, re.M | re.S)
        if not match:
            raise OpsError('所选版本缺少可读取的配置规则：' + name)
        arrays[name] = set(re.findall(r'^\s*([A-Z][A-Z0-9_]+)\s*$', match[1], re.M))
    # Keep existing PowerShell releases covered, including SENTRY_DSN.
    ps = git('show', sha + ':deploy/build-and-push.ps1', repo=repo)
    block = re.search(r'\$script:RuntimeVarKeys = @\((.*?)\n\)', ps, re.S)
    if block:
        arrays['APP_RUNTIME_KEYS'].update(re.findall(r'"([A-Z][A-Z0-9_]+)"', block[1]))
    arrays['APP_RUNTIME_KEYS'].update(EXTRA_APP_KEYS)
    # Preserve the production checks previously enforced by web-release.bat.
    arrays['APP_REQUIRED_RUNTIME_KEYS'].update({
        'CRON_SECRET', 'PROBLEM_REVIEW_PROJECTION_SECRET', 'DASHSCOPE_API_KEY',
        'WQN_ESP32_AI_PUBLIC_BASE_URL', 'WQN_ESP32_AI_AUDIO_URL_SECRET',
    })
    return arrays


def runtime_values(ref='HEAD', services=None, values=None, repo=None):
    values = dict(values or dotenv())
    arrays = policy(ref, repo)
    result = {}
    for service in services or ['app']:
        prefix = service.upper()
        if prefix not in ('APP', 'REALTIME'):
            raise OpsError('未知服务')
        allowed = arrays[prefix + '_RUNTIME_KEYS']
        needed = arrays[prefix + '_REQUIRED_RUNTIME_KEYS']
        missing = sorted(k for k in needed if not values.get(k) or values[k] in PLACEHOLDERS)
        if missing:
            raise OpsError('缺少有效配置：' + ', '.join(missing))
        legacy = values.get('SUPABASE_SERVICE_ROLE_KEY')
        if legacy:
            raise OpsError('请迁移旧 SUPABASE_SERVICE_ROLE_KEY')
        unknown = sorted(k for k in values if k.startswith('WQN_OPENCODE_') and k not in arrays['APP_RUNTIME_KEYS'])
        if service == 'app' and unknown:
            raise OpsError('目标版本不支持这些 OpenCode 配置：' + ', '.join(unknown))
        if service == 'app' and 'WQN_OPENCODE_MODEL' not in allowed:
            if bool(values.get('WQN_OPENCODE_PROVIDER_ID')) != bool(values.get('WQN_OPENCODE_MODEL_ID')):
                raise OpsError('WQN_OPENCODE_PROVIDER_ID 与 WQN_OPENCODE_MODEL_ID 必须同时配置')
        if service == 'app' and values.get('WQN_OPENCODE_USER_BINDINGS_JSON'):
            try:
                bindings = json.loads(values['WQN_OPENCODE_USER_BINDINGS_JSON'])
                if not isinstance(bindings, dict) or any(not isinstance(v, dict) for v in bindings.values()):
                    raise ValueError()
            except ValueError:
                raise OpsError('WQN_OPENCODE_USER_BINDINGS_JSON 格式无效')
        result[service] = {k: v for k, v in values.items() if k in allowed and k not in FORBIDDEN}
    return result


def validate_host(host):
    if not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}', host):
        raise OpsError('无效的 SSH 主机别名')
    return host


def rpc(action, host='aliyun', timeout=35, **fields):
    host = validate_host(host)
    encoded = base64.b64encode(REMOTE.read_bytes()).decode('ascii')
    bootstrap = ("import base64; s=base64.b64decode('%s').decode('utf-8'); "
                 "exec(compile(s,'<wqn-ops>','exec'),{'__name__':'__main__','_WQN_SOURCE':s})") % encoded
    # Source contains no credentials. The request, including env values, travels
    # only through SSH stdin. The remote command contains trusted source code.
    import shlex
    remote_command = 'python3 -c ' + shlex.quote(bootstrap)
    try:
        p = command(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', host, remote_command],
                    data=json.dumps(dict(fields, action=action), ensure_ascii=False).encode('utf-8'),
                    timeout=timeout, check=False)
    except OpsError as exc:
        raise TransportError('SSH 连接未核实；请按操作 ID 查询云端结果') from exc
    try:
        response = json.loads(p.stdout)
    except ValueError:
        raise TransportError('SSH 未返回有效结果；请检查连接与云端 Python 3。操作结果可能需要重新核实')
    if not response.get('ok'):
        raise OpsError(response.get('error', '云端操作失败'))
    return response['result']


def environment_plan(host='aliyun', ref='HEAD', services=None, preview=False):
    services = services or ['app']
    if services != ['app']:
        raise OpsError('当前环境更新入口仅处理 App；Realtime 配置随完整发布更新')
    status = rpc('status', host)
    app = next((s for s in status['services'] if s['service'] == 'app'), None)
    version = app['image'].get('revision') if app else None
    evidence = 'image_label'
    if not version and app:
        history = rpc('history', host)
        for operation in history['operations']:
            if operation.get('kind') != 'deploy' or operation.get('status') != 'verified':
                continue
            image = operation.get('images', {}).get('app', {})
            if image.get('image_id') == app['image']['image_id'] and operation.get('source', {}).get('sha'):
                version = operation['source']['sha']
                evidence = 'cloud_receipt'
                break
    if not version and app:
        match = re.search(r'-([a-f0-9]{7,40})(?:-rt)?$', app.get('image_ref', ''))
        if match:
            version = match[1]
            evidence = 'image_tag_inference'
    if not version:
        raise OpsError('运行镜像缺少可识别源码版本；先核实并导入版本信息后更新配置')
    version = resolve(version)
    values = runtime_values(version, services)
    report = scan(ref)
    if preview:
        result = rpc('preview_env', host, service='app', env=values['app'])
    else:
        result = rpc('prepare', host, kind='env', services=services, env=values,
                     source=source_metadata(report))
    result['policy_revision'] = version
    result['policy_evidence'] = evidence
    return result


def rollback_plan(target, host='aliyun', services=None):
    return rpc('prepare', host, kind='rollback', services=services or ['app'], target_id=target,
               source=source_metadata(scan()))


def wait_operation(op_id, host='aliyun', callback=None, timeout=600):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = rpc('operation', host, id=op_id)
        if callback:
            callback(data)
        if data['status'] not in ('queued', 'running'):
            return data
        time.sleep(2)
    raise OpsError('等待超时；请按操作 ID 查询云端最终结果，勿重复提交')


def immutable_checkout(sha, directory, env_data=None):
    archive = command(['git', 'archive', '--format=tar', resolve(sha)], timeout=60).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
        tf.extractall(directory, filter='data')
    source = REPO / 'web/.env.production'
    target = Path(directory) / 'web/.env.production'
    target.write_bytes(env_data if env_data is not None else source.read_bytes())
    target.chmod(0o600)
    for name in ('.wqn-builder-config.hash', '.wqn-realtime-builder-config.hash'):
        cache = REPO / 'deploy' / name
        if cache.exists():
            shutil.copyfile(cache, Path(directory) / 'deploy' / name)


def build_engine_metadata(engine):
    names = ['release.sh'] if engine == 'native' else ['build-and-push.ps1', 'build-and-push-realtime.ps1']
    scripts = {name: hashlib.sha256((REPO / 'deploy' / name).read_bytes()).hexdigest() for name in names}
    return {'name': engine, 'scripts': scripts,
            'sha256': hashlib.sha256(json.dumps(scripts, sort_keys=True).encode()).hexdigest()}


def stage_build_engine(metadata, directory):
    for name, digest in metadata['scripts'].items():
        data = (REPO / 'deploy' / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise OpsError('发布工具已经变化，请重新生成发布计划')
        target = Path(directory) / name
        target.write_bytes(data)
        target.chmod(0o600)


def build_process(args, directory, run_env, secret_values, host, operation_id, callback):
    p = subprocess.Popen(args, cwd=directory, env=run_env, start_new_session=True,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        lines = []
        for raw in p.stdout:
            line = raw.rstrip()
            for secret in secret_values:
                line = line.replace(secret, '[redacted]')
            line = re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@', r'\1[redacted]@', line)
            lines.append(line)
            if callback:
                callback({'status': 'building', 'id': operation_id, 'log_line': line})
            if len(lines) >= 30:
                rpc('append_log', host, id=operation_id, text=('\n'.join(lines) + '\n')[-65536:])
                lines.clear()
        if lines:
            rpc('append_log', host, id=operation_id, text=('\n'.join(lines) + '\n')[-65536:])
        if p.wait():
            raise OpsError('构建推送失败；未执行部署')
    finally:
        if p.poll() is None:
            try:
                if os.name == 'posix':
                    os.killpg(p.pid, signal.SIGTERM)
                else:
                    p.terminate()
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name == 'posix':
                    os.killpg(p.pid, signal.SIGKILL)
                else:
                    p.kill()
                p.wait()
        p.stdout.close()


def image_manifest(ref):
    p = command(['docker', 'buildx', 'imagetools', 'inspect', ref,
                 '--format', '{{json .Manifest}}'], timeout=60)
    try:
        data = json.loads(p.stdout)
        digest = data.get('digest') or data.get('Digest')
        if not digest or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise ValueError()
        return {'ref': ref, 'digest': digest}
    except (ValueError, AttributeError):
        raise OpsError('无法核验已推送镜像的 digest')


def release(ref='HEAD', host='aliyun', tag=None, rt_tag=None, skip_realtime=False,
            no_deploy=False, engine='native', approve=False, defer_reason=None,
            callback=None, build_options=None):
    report = scan(ref)
    if report['shallow'] or report['refs_checked'] < report['refs_total']:
        raise OpsError('提交历史检查不完整；请补齐历史后重试')
    decisions = review_decisions(report, rpc('decisions', host))
    unresolved = [o for o in report['omissions'] if o['fingerprint'] not in decisions]
    if unresolved and not defer_reason:
        raise OpsError('存在尚未核对的程序补丁；先在面板核对候选内容并记录暂缓原因，或提供 --defer-reason')
    if not approve:
        raise OpsError('发布前需要确认具体计划')
    if defer_reason:
        for row in unresolved:
            rpc('defer', host, decision={**row, 'reason': defer_reason})
    env_data = (REPO / 'web/.env.production').read_bytes()
    values = dotenv(data=env_data)
    missing_build = [k for k in ('ACR_SERVER', 'ACR_NAMESPACE', 'ACR_REPO', 'ACR_USERNAME',
                                 'ACR_PASSWORD', 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
                     if not values.get(k) or values[k] in PLACEHOLDERS]
    if missing_build:
        raise OpsError('缺少有效构建配置：' + ', '.join(missing_build))
    services = ['app'] if skip_realtime else ['app', 'realtime']
    envs = runtime_values(report['candidate']['sha'], services, values)
    # Validate the deployment origin before any cloud mutation.
    app_url = values.get('NEXT_PUBLIC_SUPABASE_URL', '')
    rt_url = values.get('SUPABASE_URL', '')
    from urllib.parse import urlsplit
    a, r = urlsplit(app_url), urlsplit(rt_url)
    expected_host = values.get('WQN_SUPABASE_EXPECTED_HOST', '').lower()
    if a.scheme not in ('http', 'https') or not a.hostname or a.hostname.lower() != expected_host:
        raise OpsError('Supabase 来源与预期主机不一致')
    if a.hostname.endswith('.supabase.co'):
        raise OpsError('发布配置仍指向旧 Supabase Cloud')
    if 'realtime' in services and (a.scheme, a.netloc) != (r.scheme, r.netloc):
        raise OpsError('App 与 Realtime 的 Supabase 来源不一致')
    if a.scheme == 'http' and values.get('WQN_ALLOW_HTTP_SUPABASE_ORIGIN') != a.scheme + '://' + a.netloc:
        raise OpsError('HTTP Supabase 来源未明确允许')
    sha = report['candidate']['sha']
    tag = tag or datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + sha[:12] + '-' + secrets.token_hex(3)
    rt_tag = rt_tag or tag + '-rt'
    if any(not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', v) for v in (tag, rt_tag)) or tag == 'latest':
        raise OpsError('请使用唯一版本 tag')
    base = values['ACR_SERVER'] + '/' + values['ACR_NAMESPACE'] + '/'
    images = {'app': base + values['ACR_REPO'] + ':' + tag}
    if 'realtime' in services:
        images['realtime'] = base + 'wqn-realtime:' + rt_tag
    build_source = dict(source_metadata(report), build_engine=build_engine_metadata(engine))
    build_record = rpc('prepare', host, kind='build', services=services, images=images,
                       env=envs, source=build_source)
    if callback:
        callback(build_record)
    secret_values = [v for k, v in values.items() if re.search('KEY|SECRET|TOKEN|PASSWORD|AUTH|PRIVATE|DATABASE|DSN', k) and len(v) >= 4]
    try:
        with tempfile.TemporaryDirectory(prefix='wqn-release-') as directory, tempfile.TemporaryDirectory(prefix='wqn-build-engine-') as engine_dir:
            immutable_checkout(sha, directory, env_data=env_data)
            stage_build_engine(build_source['build_engine'], engine_dir)
            run_env = dict(os.environ, WQN_OPS_MANAGED='1', WQN_OPS_SOURCE_SHA=sha,
                           WQN_OPS_SOURCE_DIR=directory, WQN_OPS_ENGINE_SHA256=build_source['build_engine']['sha256'],
                           WQN_OPS_SOURCE_TIME=report['candidate']['commit_time'], WQN_OPS_BUILD_TIME=now())
            if engine == 'native':
                args = ['bash', str(Path(engine_dir) / 'release.sh'), tag, '--no-deploy', '--rt-tag', rt_tag]
                if skip_realtime:
                    args.append('--skip-realtime')
                if '-RecreateBuilder' in (build_options or []):
                    args.append('--recreate-builders')
                if '-NoBuildProxy' in (build_options or []):
                    run_env['WQN_BUILD_PROXY'] = ''
                elif '-BuildProxy' in (build_options or []):
                    run_env['WQN_BUILD_PROXY'] = build_options[build_options.index('-BuildProxy') + 1]
            else:
                args = ['pwsh', '-NoProfile', '-File', str(Path(engine_dir) / 'build-and-push.ps1'), '-Tag', tag]
                args += build_options or []
            rpc('event', host, id=build_record['id'], step='build_push', status='running')
            processes = [args]
            if engine != 'native' and not skip_realtime:
                processes.append(['pwsh', '-NoProfile', '-File', str(Path(engine_dir) / 'build-and-push-realtime.ps1'), '-Tag', rt_tag])
            for args in processes:
                build_process(args, directory, run_env, secret_values, host, build_record['id'], callback)
            for name in ('.wqn-builder-config.hash', '.wqn-realtime-builder-config.hash'):
                cache = Path(directory) / 'deploy' / name
                if cache.exists():
                    shutil.copyfile(cache, REPO / 'deploy' / name)
            manifests = {s: image_manifest(image) for s, image in images.items()}
            rpc('finish_build', host, id=build_record['id'], success=True, images=manifests)
    except TransportError:
        # The cloud still has the last durable receipt. Leave its result
        # uncertain until the operator reconnects instead of inventing failure.
        raise
    except Exception:
        rpc('finish_build', host, id=build_record['id'], success=False)
        raise
    if no_deploy:
        return rpc('operation', host, id=build_record['id'])
    # Use registry digests when supported; the remote worker records resolved
    # image identity and will not run a different locally retagged image.
    pinned = {s: images[s].rsplit(':', 1)[0] + '@' + m['digest'] for s, m in manifests.items()}
    plan = rpc('prepare', host, kind='deploy', services=services, images=pinned,
               env=envs, source=build_source, build_id=build_record['id'])
    rpc('event', host, id=plan['id'], step='build_operation', status='passed', detail=build_record['id'])
    rpc('apply', host, id=plan['id'])
    if callback:
        callback(plan)
    return wait_operation(plan['id'], host, callback)
