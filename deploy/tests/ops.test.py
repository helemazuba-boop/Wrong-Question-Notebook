#!/usr/bin/env python3
"""Behavioral tests for cloud transactions, Git evidence and loopback API."""
import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener

DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
from ops import core, remote, server


DOCKER = r'''#!/usr/bin/env python3
import copy,json,os,sys
path=os.environ['WQN_MOCK_STATE']
with open(path) as f: state=json.load(f)
args=sys.argv[1:]
state.setdefault('calls',[]).append(args)
def save():
    with open(path,'w') as f: json.dump(state,f)
def finish(code=0):
    save();sys.exit(code)
if args[0]=='inspect':
    ref=args[-1]
    obj=state['containers'].get(ref) or state['images'].get(ref)
    if not obj: finish(1)
    print(json.dumps([obj]));finish()
if args[0]=='logs':
    print('authorization: Bearer fixture-token')
    print('password=fixture-password')
    print('ordinary application log');finish()
if args[0]=='pull':
    finish(1 if state.get('fail_pull')==args[1] else 0)
if args[0]=='stop':
    state['containers'][args[-1]]['State']['Running']=False;finish()
if args[0]=='start':
    state['containers'][args[-1]]['State']['Running']=True;finish()
if args[0]=='rename':
    c=state['containers'].pop(args[1]);c['Name']='/'+args[2]
    state['containers'][args[2]]=c;finish()
if args[0]=='rm':
    state['containers'].pop(args[-1],None);finish()
if args[0]=='run':
    name=args[args.index('--name')+1]
    envfile=args[args.index('--env-file')+1]
    image_pos=next(i for i,a in enumerate(args) if a.startswith('sha256:'))
    image_id=args[image_pos]
    backup=next(c for n,c in state['containers'].items() if n.startswith(name+'.ops-'))
    c=copy.deepcopy(backup)
    c['Id']='new-'+name;c['Name']='/'+name;c['Image']=image_id
    c['Config']=copy.deepcopy(state['images'][image_id]['Config'])
    c['Config']['Image']=image_id
    env=dict(x.split('=',1) for x in c['Config'].get('Env',[]))
    with open(envfile) as f:
        for line in f:
            k,v=line.rstrip('\n').split('=',1);env[k]=v
    if state.get('tamper_env'): env['WQN_OPENCODE_MODEL_ID']='wrong-model'
    c['Config']['Env']=[k+'='+v for k,v in env.items()]
    c['State']={'Running':True}
    state['containers'][name]=c
    print('new-container-id');finish()
if args[0]=='exec':
    c=state['containers'][args[1]]
    finish(1 if state.get('fail_new_health') and c['Id'].startswith('new-') else 0)
finish(1)
'''


def image(letter, tag):
    image_id = 'sha256:' + letter * 64
    return {'Id': image_id, 'Created': '2026-10-27T00:00:00Z', 'RepoTags': [tag],
            'RepoDigests': [tag.rsplit(':', 1)[0] + '@sha256:' + letter * 64],
            'Config': {'Env': ['NODE_ENV=production', 'HOSTNAME=0.0.0.0'],
                       'Entrypoint': None, 'Cmd': ['node', 'server.js'],
                       'Labels': {'org.opencontainers.image.revision': letter * 40}}}


def container(name, img, password='fixture-password'):
    return {'Id': 'old-' + name, 'Image': img['Id'], 'Name': '/' + name,
            'Created': '2026-10-27T01:00:00Z', 'Mounts': [], 'RestartCount': 0,
            'State': {'Running': True, 'StartedAt': '2026-10-27T01:00:00Z'},
            'Config': dict(copy.deepcopy(img['Config']), Image=img['RepoTags'][0],
                           Env=img['Config']['Env'] + ['WQN_OPENCODE_SERVER_PASSWORD=' + password,
                               'WQN_OPENCODE_MODEL_ID=old-model', 'REMOVED_KEY=remove-me']),
            'HostConfig': {'NetworkMode': 'wqn-runtime', 'RestartPolicy': {'Name': 'unless-stopped'},
                           'PortBindings': {'3000/tcp': [{'HostIp': '', 'HostPort': '3000'}]},
                           'IpcMode': 'private'},
            'NetworkSettings': {'Networks': {'wqn-runtime': {'Aliases': [name, 'wqn']}}}}


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cloud = self.root / 'cloud'
        self.home = self.root / 'home'
        self.home.mkdir()
        self.state_file = self.root / 'docker.json'
        self.img1 = image('a', 'registry.example.test/wqn/app:v1')
        self.img2 = image('b', 'registry.example.test/wqn/app:v2')
        rt = image('c', 'registry.example.test/wqn/realtime:v1')
        images = {}
        for img in (self.img1, self.img2, rt):
            images[img['Id']] = img
            for ref in img['RepoTags'] + img['RepoDigests']:
                images[ref] = img
        self.state = {'containers': {'wqn-app': container('wqn-app', self.img1),
                                      'wqn-realtime': container('wqn-realtime', rt)},
                      'images': images}
        self.save()
        binary = self.root / 'docker'
        binary.write_text(DOCKER)
        binary.chmod(0o700)
        self.patch_env = mock.patch.dict(os.environ, {
            'PATH': str(self.root) + ':' + os.environ['PATH'], 'WQN_MOCK_STATE': str(self.state_file),
            'WQN_OPS_ROOT': str(self.cloud), 'WQN_OPS_HOME': str(self.home),
        })
        self.patch_env.start()
        self.addCleanup(self.patch_env.stop)
        for name, value in (('ROOT', self.cloud), ('HOME_DIR', self.home),
                            ('_WQN_SOURCE', (DEPLOY / 'ops/remote.py').read_text())):
            patch = mock.patch.object(remote, name, value, create=True)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(remote.time, 'sleep')
        patch.start()
        self.addCleanup(patch.stop)

    def save(self):
        self.state_file.write_text(json.dumps(self.state))

    def load(self):
        self.state = json.loads(self.state_file.read_text())
        return self.state

    def plan(self, kind='env', **extra):
        req = {'kind': kind, 'services': ['app'],
               'env': {'app': {'WQN_OPENCODE_MODEL_ID': 'new-model',
                                'WQN_OPENCODE_SERVER_PASSWORD': 'new-fixture-secret',
                                'EXPLICIT_EMPTY': ''}},
               'source': {'branch': 'feature/test', 'sha': 'a' * 40}}
        req.update(extra)
        return remote.create(req)

    def test_read_only_status_and_history_do_not_initialize_archive(self):
        status = remote.dispatch({'action': 'status'})
        self.assertEqual(len(status['services']), 2)
        self.assertNotIn('fixture-password', json.dumps(status))
        self.assertEqual(remote.dispatch({'action': 'history'})['operations'], [])
        self.assertFalse(self.cloud.exists())

    def test_deferral_updates_keep_prior_reason_and_exact_commit_metadata(self):
        self.cloud.mkdir()
        decision = {'fingerprint': 'a' * 64, 'reason': 'wait for worker validation', 'branch': 'feat/worker',
                    'missing': [{'sha': 'b' * 40, 'patch_id': 'c' * 40, 'subject': 'worker',
                                 'commit_time': '2026-10-27T00:00:00Z', 'variants': []}]}
        remote.dispatch({'action': 'defer', 'decision': decision})
        result = remote.dispatch({'action': 'defer', 'decision': dict(decision, reason='wait for migration validation')})
        saved = result['a' * 64]
        self.assertEqual(saved['reason'], 'wait for migration validation')
        self.assertEqual(saved['history'][0]['reason'], 'wait for worker validation')
        self.assertEqual(saved['commits'][0]['sha'], 'b' * 40)
        self.assertEqual(remote.dispatch({'action': 'decisions'})['a' * 64], saved)

    def test_env_update_keeps_image_and_records_verified_actual_state(self):
        plan = self.plan()
        remote.worker(plan['id'])
        result = remote.record(plan['id'])
        self.assertEqual(result['status'], 'verified', result)
        c = self.load()['containers']['wqn-app']
        self.assertEqual(c['Image'], self.img1['Id'])
        env = remote.env_dict(c['Config']['Env'])
        self.assertEqual(env['WQN_OPENCODE_MODEL_ID'], 'new-model')
        self.assertEqual(env['EXPLICIT_EMPTY'], '')
        self.assertNotIn('REMOVED_KEY', env)
        self.assertNotIn('new-fixture-secret', (remote.op_dir(plan['id']) / 'record.json').read_text())
        self.assertNotIn('new-fixture-secret', (remote.op_dir(plan['id']) / 'after.enc').read_text())
        self.assertEqual((self.cloud / 'vault.key').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.home / '.env.wqn-app').stat().st_mode & 0o777, 0o600)

    def test_changed_container_after_preview_is_not_touched(self):
        plan = self.plan()
        self.state['containers']['wqn-app']['Id'] = 'changed-container'
        self.save()
        remote.worker(plan['id'])
        self.assertEqual(remote.record(plan['id'])['status'], 'failed')
        calls = self.load()['calls']
        self.assertFalse(any(c[0] == 'stop' for c in calls))

    def test_wrong_effective_env_rolls_back_and_verifies_old_service(self):
        plan = self.plan()
        self.state['tamper_env'] = True
        self.save()
        remote.worker(plan['id'])
        result = remote.record(plan['id'])
        self.assertEqual(result['status'], 'rolled_back', result)
        self.assertEqual(result['recovery'], 'verified')
        self.assertEqual(self.load()['containers']['wqn-app']['Id'], 'old-wqn-app')
        self.assertTrue(self.state['containers']['wqn-app']['State']['Running'])

    def test_failed_startup_rolls_back_instead_of_reporting_success(self):
        plan = self.plan()
        self.state['fail_new_health'] = True
        self.save()
        remote.worker(plan['id'])
        self.assertEqual(remote.record(plan['id'])['status'], 'rolled_back')

    def test_all_pulls_finish_before_any_container_is_stopped(self):
        self.state['fail_pull'] = 'registry.example.test/wqn/app:v2'
        self.save()
        plan = self.plan(kind='deploy', images={'app': self.img2['RepoTags'][0]})
        remote.worker(plan['id'])
        self.assertEqual(remote.record(plan['id'])['status'], 'failed')
        self.assertFalse(any(c[0] == 'stop' for c in self.load()['calls']))

    def test_rollback_restores_target_snapshot_not_current_env(self):
        first = self.plan()
        remote.worker(first['id'])
        second = self.plan(env={'app': {'WQN_OPENCODE_MODEL_ID': 'third-model'}})
        remote.worker(second['id'])
        rollback = self.plan(kind='rollback', target_id=first['id'])
        remote.worker(rollback['id'])
        result = remote.record(rollback['id'])
        self.assertEqual(result['status'], 'verified', result)
        self.assertEqual(remote.env_dict(self.load()['containers']['wqn-app']['Config']['Env'])['WQN_OPENCODE_MODEL_ID'], 'new-model')
        self.assertEqual(result['target_id'], first['id'])

    def test_snapshot_tampering_is_rejected_before_decryption(self):
        plan = self.plan()
        path = remote.op_dir(plan['id']) / 'desired.enc'
        value = json.loads(path.read_text())
        value['mac'] = '0' * 64
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(remote.OpsError, 'authentication'):
            remote.unseal(path)

    def test_custom_mounts_and_resource_settings_are_not_silently_dropped(self):
        self.state['containers']['wqn-app']['Mounts'] = [{'Source': '/data'}]
        self.save()
        with self.assertRaisesRegex(remote.OpsError, 'custom adapter'):
            self.plan()

    def test_used_plan_cannot_execute_twice(self):
        plan = self.plan()
        with mock.patch.object(remote.subprocess, 'Popen', return_value=mock.Mock(pid=99999999)):
            remote.apply({'id': plan['id']})
            with self.assertRaisesRegex(remote.OpsError, 'already been used'):
                remote.apply({'id': plan['id']})

    def test_logs_mask_known_values_and_authorization(self):
        text = remote.log_chunk('app')
        self.assertNotIn('fixture-token', text)
        self.assertNotIn('fixture-password', text)
        self.assertIn('ordinary application log', text)

    def test_cloud_lock_prevents_second_mutation(self):
        plan = self.plan()
        with remote.lock(self.cloud / '.mutation.lock'):
            remote.worker(plan['id'])
        self.assertEqual(remote.record(plan['id'])['status'], 'failed')
        self.assertFalse(any(c[0] == 'stop' for c in self.load()['calls']))

    def test_no_env_changes_does_not_offer_container_recreation(self):
        current = remote.env_dict(self.state['containers']['wqn-app']['Config']['Env'])
        plan = self.plan(env={'app': current})
        self.assertEqual(plan['status'], 'no_changes')
        with self.assertRaises(remote.OpsError):
            remote.apply({'id': plan['id']})

    def test_build_time_state_changes_require_new_deployment_review(self):
        build = self.plan(kind='build', images={'app': self.img2['RepoTags'][0]})
        remote.dispatch({'action': 'finish_build', 'id': build['id'], 'success': True,
                         'images': {'app': {'ref': self.img2['RepoTags'][0], 'digest': 'sha256:' + 'b' * 64}}})
        self.state['containers']['wqn-app']['Config']['Env'].append('CONCURRENT_CHANGE=1')
        self.save()
        with self.assertRaisesRegex(remote.OpsError, 'changed during build'):
            self.plan(kind='deploy', images={'app': self.img2['RepoDigests'][0]}, build_id=build['id'])

    def test_baseline_is_observation_not_invented_deployment(self):
        baseline = remote.create({'kind': 'baseline', 'services': ['app']})
        self.assertEqual(baseline['status'], 'verified')
        self.assertTrue(baseline['observed_only'])
        self.assertIsNone(baseline['source']['sha'])
        self.assertTrue((remote.op_dir(baseline['id']) / 'after.enc').exists())

    def test_rollback_can_recover_a_stopped_container(self):
        baseline = remote.create({'kind': 'baseline', 'services': ['app']})
        self.state['containers']['wqn-app']['State']['Running'] = False
        self.save()
        plan = self.plan(kind='rollback', target_id=baseline['id'])
        remote.worker(plan['id'])
        self.assertEqual(remote.record(plan['id'])['status'], 'verified')
        self.assertTrue(self.load()['containers']['wqn-app']['State']['Running'])

    def test_registry_failure_is_unverified_not_invented_deletion(self):
        plan = self.plan()
        result = remote.dispatch({'action': 'image_probe', 'id': plan['id'], 'service': 'app'})
        self.assertFalse(result['available'])
        self.assertIn('unverified', result['reason'])

    def test_external_cloud_changes_are_detected_against_saved_receipt(self):
        remote.create({'kind': 'baseline', 'services': ['app']})
        status = remote.dispatch({'action': 'status'})
        self.assertEqual(status['services'][0]['drift']['status'], 'matches')
        self.load()['containers']['wqn-app']['Config']['Env'].append('EXTERNAL_CHANGE=1')
        self.save()
        status = remote.dispatch({'action': 'status'})
        self.assertEqual(status['services'][0]['drift']['status'], 'changed')

    def test_missing_recovery_key_is_not_silently_replaced(self):
        plan = self.plan()
        (self.cloud / 'vault.key').unlink()
        with self.assertRaisesRegex(remote.OpsError, 'key is missing'):
            remote.unseal(remote.op_dir(plan['id']) / 'before.enc')
        self.assertFalse((self.cloud / 'vault.key').exists())

    def test_browser_build_variables_cannot_be_falsely_updated_at_runtime(self):
        with self.assertRaisesRegex(remote.OpsError, 'publish a new image'):
            self.plan(env={'app': {'NEXT_PUBLIC_SUPABASE_URL': 'https://different.example.test'}})
        self.assertFalse(any(c[0] == 'stop' for c in self.load()['calls']))

    def test_app_only_update_cannot_rotate_a_shared_realtime_secret(self):
        with self.assertRaisesRegex(remote.OpsError, 'update both services'):
            self.plan(env={'app': {'WQN_REALTIME_PROXY_SECRET': 'changed-shared-secret'}})


class GitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.run_git('init', '-b', 'release')
        self.run_git('config', 'user.name', 'Fixture')
        self.run_git('config', 'user.email', 'fixture@example.test')
        self.commit('base', 'base.txt')
        self.base = self.run_git('rev-parse', 'HEAD')

    def run_git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self, message, file):
        (self.repo / file).write_text(message)
        self.run_git('add', file)
        self.run_git('commit', '-m', message)
        return self.run_git('rev-parse', 'HEAD')

    def test_missing_commit_and_cherry_pick_equivalence_are_separate(self):
        self.run_git('checkout', '-b', 'feature')
        equivalent = self.commit('equivalent', 'equivalent.txt')
        missing = self.commit('bounded fallback', 'fallback.txt')
        self.run_git('checkout', 'release')
        self.run_git('cherry-pick', equivalent)
        self.run_git('commit', '--amend', '-m', 'equivalent landed separately')
        report = core.scan(repo=self.repo)
        row = next(o for o in report['omissions'] if o['branch'] == 'feature')
        self.assertEqual([c['sha'] for c in row['missing']], [missing])
        self.assertEqual(row['equivalent_count'], 1)
        detail = core.context(missing, 'feature', repo=self.repo)
        self.assertEqual(detail['target']['sha'], missing)
        self.assertTrue(detail['before'])
        self.assertIn('author_time', detail['target'])

    def test_ref_options_are_rejected(self):
        with self.assertRaises(core.OpsError):
            core.resolve('--help', self.repo)

    def test_local_and_remote_variants_keep_both_sides_without_double_counting(self):
        self.run_git('checkout', '-b', 'feat/work')
        shared = self.commit('shared feature', 'shared.txt')
        remote = self.commit('remote only', 'remote.txt')
        self.run_git('update-ref', 'refs/remotes/origin/feat/work', remote)
        self.run_git('reset', '--hard', shared)
        local = self.commit('local only', 'local.txt')
        self.run_git('checkout', 'release')
        row, = core.scan(repo=self.repo)['omissions']
        self.assertEqual({c['sha'] for c in row['missing']}, {shared, local, remote})
        self.assertEqual(set(row['aliases']), {'feat/work', 'origin/feat/work'})
        only_local_reason = hashlib.sha256('\n'.join(sorted([shared, local])).encode()).hexdigest()
        decisions = core.review_decisions({'omissions': [row]}, {only_local_reason: {'reason': 'local reviewed'}})
        self.assertNotIn(row['fingerprint'], decisions, 'review of one divergent tip must not acknowledge the other')

    def test_cherry_picked_feature_is_one_review_and_keeps_old_reasons(self):
        self.run_git('checkout', '-b', 'feat/marking')
        original = self.commit('classification pipeline', 'marking.txt')
        self.run_git('checkout', '-b', 'merge/marking-release', self.base)
        self.run_git('cherry-pick', original)
        self.run_git('commit', '--amend', '-m', 'classification pipeline for release')
        copied = self.run_git('rev-parse', 'HEAD')
        self.run_git('checkout', 'release')
        report = core.scan(repo=self.repo)
        row, = report['omissions']
        self.assertEqual(row['branch'], 'merge/marking-release')
        self.assertEqual(row['missing_count'], 1)
        self.assertEqual({v['sha'] for v in row['missing'][0]['variants']}, {original, copied})
        key = hashlib.sha256(original.encode()).hexdigest()
        saved = {key: {'reason': 'wait for worker acceptance', 'time': '2026-10-27T00:00:00Z'}}
        resolved = core.review_decisions(report, saved)
        self.assertEqual(resolved[row['fingerprint']]['reason'], 'wait for worker acceptance')
        self.assertEqual(saved, {key: {'reason': 'wait for worker acceptance', 'time': '2026-10-27T00:00:00Z'}})

    def test_overlapping_branches_count_each_patch_once_and_do_not_reuse_partial_deferral(self):
        self.run_git('checkout', '-b', 'feature-one')
        first = self.commit('first feature', 'one.txt')
        self.run_git('checkout', '-b', 'feature-two')
        second = self.commit('second feature', 'two.txt')
        self.run_git('checkout', 'release')
        report = core.scan(repo=self.repo)
        row, = report['omissions']
        self.assertEqual(row['missing_count'], 2)
        self.assertEqual({c['sha'] for c in row['missing']}, {first, second})
        saved = {hashlib.sha256(first.encode()).hexdigest(): {'reason': 'only first feature deferred'}}
        self.assertNotIn(row['fingerprint'], core.review_decisions(report, saved))

    def test_tooling_does_not_invalidate_runtime_reason_but_new_runtime_does(self):
        self.run_git('checkout', '-b', 'feature')
        self.commit('fallback', 'fallback.txt')
        self.run_git('checkout', 'release')
        first = core.scan(repo=self.repo)['omissions'][0]['fingerprint']
        self.run_git('checkout', 'feature')
        (self.repo / 'deploy').mkdir()
        self.commit('env update', 'deploy/update-env.sh')
        self.run_git('checkout', 'release')
        row, = core.scan(repo=self.repo)['omissions']
        self.assertEqual(row['fingerprint'], first)
        self.assertEqual(len(row['related']), 1)
        self.run_git('checkout', 'feature')
        self.commit('new runtime behavior', 'new.txt')
        self.run_git('checkout', 'release')
        self.assertNotEqual(core.scan(repo=self.repo)['omissions'][0]['fingerprint'], first)

    def test_mixed_backports_ignore_tooling_differences_when_reviewing_runtime(self):
        for branch, tool in (('feature', 'original tool'), ('backport', 'adapted tool')):
            self.run_git('checkout', '-b', branch, self.base)
            (self.repo / 'deploy').mkdir(exist_ok=True)
            (self.repo / 'deploy/helper.sh').write_text(tool)
            (self.repo / 'runtime.txt').write_text('same program change')
            self.run_git('add', '.')
            self.run_git('commit', '-m', 'runtime with tooling')
        self.run_git('checkout', 'release')
        row, = core.scan(repo=self.repo)['omissions']
        self.assertEqual(row['missing_count'], 1)
        self.assertEqual(len(row['missing'][0]['variants']), 2)
        self.assertEqual(row['missing'][0]['reviewed_paths'], ['runtime.txt'])
        self.commit('same program change', 'runtime.txt')
        report = core.scan(repo=self.repo)
        self.assertFalse(report['omissions'], 'different tooling must not turn included runtime content into an omission')

    def test_external_repository_and_default_branch_configuration_are_references(self):
        self.run_git('remote', 'add', 'origin', 'git@github.com:owner/project.git')
        self.run_git('remote', 'add', 'upstream', 'https://github.com/other/project.git')
        self.run_git('checkout', '-b', 'external-work')
        external = self.commit('external feature', 'external.txt')
        self.run_git('update-ref', 'refs/remotes/upstream/main', external)
        self.run_git('checkout', 'release')
        self.run_git('branch', '-D', 'external-work')
        self.run_git('checkout', '-b', 'chore/config')
        (self.repo / '.github').mkdir()
        self.commit('target dependabot branch', '.github/dependabot.yml')
        self.run_git('checkout', 'release')
        report = core.scan(repo=self.repo)
        self.assertEqual(report['omissions'], [])
        refs = {r['branch']: r for r in report['references']}
        self.assertIn('外部仓库', refs['upstream/main']['reason'])
        self.assertEqual(refs['chore/config']['missing'][0]['category'], 'configuration')
        self.assertEqual(core.repository_id('ssh://git@github.com/Owner/Project.git'), report['repository'])

    def test_squash_combination_is_detected_by_file_contents(self):
        self.run_git('checkout', '-b', 'feature')
        self.commit('feature part', 'part.txt')
        self.run_git('checkout', 'release')
        (self.repo / 'part.txt').write_text('feature part')
        self.commit('squashed feature and another change', 'another.txt')
        self.run_git('add', 'part.txt')
        self.run_git('commit', '--amend', '--no-edit')
        report = core.scan(repo=self.repo)
        self.assertEqual(report['omissions'], [])
        self.assertEqual(report['references'][0]['missing'][0]['coverage'], 'postimages_match')

    def test_later_file_changes_can_still_match_reverse_patch(self):
        base = ''.join('line %d\n' % i for i in range(40))
        (self.repo / 'base.txt').write_text(base)
        self.run_git('commit', '-am', 'prepare context')
        self.run_git('checkout', '-b', 'feature')
        feature = base.replace('line 5\n', 'feature behavior\n')
        (self.repo / 'base.txt').write_text(feature)
        self.run_git('commit', '-am', 'feature')
        self.run_git('checkout', 'release')
        (self.repo / 'base.txt').write_text(feature.replace('line 35\n', 'later unrelated change\n'))
        self.run_git('commit', '-am', 'squashed and extended')
        report = core.scan(repo=self.repo)
        self.assertEqual(report['omissions'], [])
        self.assertEqual(report['references'][0]['missing'][0]['coverage'], 'reverse_patch_matches')

    def test_staged_and_untracked_work_is_not_candidate_inclusion_evidence(self):
        self.run_git('checkout', '-b', 'feature')
        commit = self.commit('feature', 'feature.txt')
        self.run_git('checkout', 'release')
        (self.repo / 'feature.txt').write_text('feature')
        self.run_git('add', 'feature.txt')
        self.run_git('status', '--porcelain')
        index = self.repo / '.git/index'
        before = index.read_bytes()
        row, = core.scan(repo=self.repo)['omissions']
        self.assertEqual(row['missing'][0]['sha'], commit)
        self.assertEqual(row['missing'][0]['workspace_paths'], ['feature.txt'])
        self.assertEqual(row['missing'][0]['coverage'], 'unmatched')
        self.assertEqual(index.read_bytes(), before)

    def test_identical_subjects_do_not_collapse_different_patches(self):
        for name in ('first', 'second'):
            self.run_git('checkout', '-b', name, self.base)
            self.commit('same title', name + '.txt')
        self.run_git('checkout', 'release')
        self.assertEqual(len(core.scan(repo=self.repo)['omissions']), 2)

    def test_github_query_is_pinned_to_origin_and_verifies_post_merge_commits(self):
        self.run_git('remote', 'add', 'origin', 'git@github.com:owner/project.git')
        self.run_git('checkout', '-b', 'feature')
        head = self.commit('merged feature', 'feature.txt')
        tip = self.commit('new work after merge', 'new.txt')
        self.run_git('checkout', 'release')
        pr = {'number': 92, 'headRefName': 'feature', 'headRefOid': head, 'state': 'MERGED'}
        original = core.command
        calls = []
        def command(args, **kwargs):
            if args[0] == 'gh':
                calls.append(args)
                return subprocess.CompletedProcess(args, 0, json.dumps([pr]).encode(), b'')
            return original(args, cwd=self.repo, **{k: v for k, v in kwargs.items() if k != 'cwd'})
        with mock.patch.object(core, 'REPO', self.repo), mock.patch.object(core, 'command', side_effect=command):
            result = core.github_prs()
        self.assertEqual(calls[0][calls[0].index('--repo') + 1], 'owner/project')
        check, = result['pull_requests'][0]['ref_checks']
        self.assertEqual((check['sha'], check['relationship'], check['followup_count']), (tip, 'followup', 1))
        self.assertFalse(result['pull_requests'][0]['head_ancestor_of_candidate'])

    def test_dotenv_is_data_and_preserves_empty_and_quoted_hash(self):
        path = self.repo / '.env'
        path.write_text('export EMPTY=\nKEY="keep # hash"\nVALUE=one#two # comment\nCMD=$(touch never)\n')
        values = core.dotenv(path)
        self.assertEqual(values['EMPTY'], '')
        self.assertEqual(values['KEY'], 'keep # hash')
        self.assertEqual(values['VALUE'], 'one#two')
        self.assertEqual(values['CMD'], '$(touch never)')
        self.assertFalse((self.repo / 'never').exists())


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        (self.repo / 'web').mkdir()
        (self.repo / 'deploy').mkdir()
        for name in ('release.sh', 'build-and-push.ps1', 'build-and-push-realtime.ps1'):
            (self.repo / 'deploy' / name).write_text('# maintained engine fixture\n')
        self.env_data = (b'ACR_SERVER=registry.example.test\nACR_NAMESPACE=wqn\nACR_REPO=app\n'
                         b'ACR_USERNAME=fixture-user\nACR_PASSWORD=fixture-password\nNEXT_SERVER_ACTIONS_ENCRYPTION_KEY=fixture-encryption-key\n'
                         b'NEXT_PUBLIC_SUPABASE_URL=https://data.example.test\n'
                         b'SUPABASE_URL=https://data.example.test\nWQN_SUPABASE_EXPECTED_HOST=data.example.test\n')
        (self.repo / 'web/.env.production').write_bytes(self.env_data)
        self.report = {'candidate': {'sha': 'a' * 40, 'branch': 'release', 'commit_time': '2026-10-27T00:00:00Z'},
                       'shallow': False, 'refs_checked': 1, 'refs_total': 1, 'omissions': [],
                       'checked_at': '2026-10-27T00:00:00Z', 'commits': [], 'worktrees': []}
        self.calls = []
        def rpc(action, host='aliyun', **kwargs):
            self.calls.append((action, kwargs))
            if action == 'decisions': return {}
            if action == 'prepare': return {'id': 'b' * 32 if kwargs['kind'] == 'build' else 'c' * 32,
                                            'kind': kwargs['kind'], 'status': 'planned'}
            if action == 'operation': return {'id': kwargs['id'], 'status': 'pushed'}
            return {}
        patches = [mock.patch.object(core, 'REPO', self.repo), mock.patch.object(core, 'scan', return_value=self.report),
                   mock.patch.object(core, 'rpc', side_effect=rpc),
                   mock.patch.object(core, 'runtime_values', return_value={'app': {'TEST_KEY': 'fixture'}}),
                   mock.patch.object(core, 'immutable_checkout'), mock.patch.object(core, 'build_process'),
                   mock.patch.object(core, 'image_manifest', side_effect=lambda ref: {'ref': ref, 'digest': 'sha256:' + 'd' * 64}),
                   mock.patch.object(core, 'wait_operation', return_value={'id': 'c' * 32, 'status': 'verified'})]
        self.mocks = []
        for patch in patches:
            self.mocks.append(patch.start())
            self.addCleanup(patch.stop)

    def test_build_only_records_push_without_deploying(self):
        result = core.release(approve=True, skip_realtime=True, no_deploy=True)
        self.assertEqual(result['status'], 'pushed')
        self.assertFalse(any(action == 'apply' for action, _ in self.calls))
        self.assertEqual(self.mocks[4].call_args.kwargs['env_data'], self.env_data)
        args, directory, run_env = self.mocks[5].call_args.args[:3]
        self.assertEqual(Path(args[1]).name, 'release.sh')
        self.assertTrue(Path(args[1]).parent.name.startswith('wqn-build-engine-'))
        self.assertNotEqual(Path(args[1]).parent.parent, Path(directory))
        self.assertEqual(run_env['WQN_OPS_SOURCE_DIR'], directory)
        prepared = next(v for action, v in self.calls if action == 'prepare')
        self.assertEqual(run_env['WQN_OPS_SOURCE_SHA'], prepared['source']['sha'])
        self.assertEqual(run_env['WQN_OPS_ENGINE_SHA256'], prepared['source']['build_engine']['sha256'])

    def test_powershell_uses_maintained_engines_for_the_pinned_source(self):
        core.release(approve=True, engine='powershell', no_deploy=True)
        calls = self.mocks[5].call_args_list
        self.assertEqual(len(calls), 2)
        for call, name in zip(calls, ('build-and-push.ps1', 'build-and-push-realtime.ps1')):
            args, directory, run_env = call.args[:3]
            self.assertEqual(Path(args[3]).name, name)
            self.assertTrue(Path(args[3]).parent.name.startswith('wqn-build-engine-'))
            self.assertEqual(run_env['WQN_OPS_SOURCE_DIR'], directory)

    def test_deployment_is_pinned_to_build_digest_and_receipt(self):
        result = core.release(approve=True, skip_realtime=True)
        self.assertEqual(result['status'], 'verified')
        deployment = next(args for action, args in self.calls if action == 'prepare' and args['kind'] == 'deploy')
        self.assertEqual(deployment['build_id'], 'b' * 32)
        self.assertTrue(deployment['images']['app'].endswith('@sha256:' + 'd' * 64))
        self.assertEqual(deployment['source']['sha'], 'a' * 40)

    def test_transport_loss_does_not_invent_failed_push_receipt(self):
        self.mocks[5].side_effect = core.TransportError('connection lost')
        with self.assertRaises(core.TransportError):
            core.release(approve=True, skip_realtime=True)
        self.assertFalse(any(action == 'finish_build' for action, _ in self.calls))
        self.assertFalse(any(action == 'apply' for action, _ in self.calls))

    def test_failed_build_never_submits_deployment(self):
        self.mocks[5].side_effect = core.OpsError('build failed')
        with self.assertRaises(core.OpsError):
            core.release(approve=True, skip_realtime=True)
        self.assertTrue(any(action == 'finish_build' and not args['success'] for action, args in self.calls))
        self.assertFalse(any(action == 'apply' for action, _ in self.calls))


class BuildStreamTests(unittest.TestCase):
    def test_build_output_is_redacted_before_callback_and_cloud_upload(self):
        events = []
        with mock.patch.object(core, 'rpc') as rpc:
            core.build_process([sys.executable, '-c', "print('secret-fixture http://user:private@proxy.example.test')"],
                               str(DEPLOY), os.environ.copy(), ['secret-fixture'], 'fixture', 'a' * 32, events.append)
        public = json.dumps(events) + str(rpc.call_args)
        self.assertNotIn('secret-fixture', public)
        self.assertNotIn('user:private', public)
        self.assertIn('[redacted]', public)

    def test_lost_cloud_journal_stops_local_build_and_preserves_uncertainty(self):
        start = time.monotonic()
        code = "import time; [print('line',i,flush=True) for i in range(30)]; time.sleep(60)"
        with mock.patch.object(core, 'rpc', side_effect=core.TransportError('connection lost')):
            with self.assertRaises(core.TransportError):
                core.build_process([sys.executable, '-u', '-c', code], str(DEPLOY),
                                   os.environ.copy(), [], 'fixture', 'a' * 32, None)
        self.assertLess(time.monotonic() - start, 5)


class BuildEngineTests(unittest.TestCase):
    def test_native_engine_builds_pinned_source_with_csv_quoted_no_proxy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, engine, binary = root / 'source', root / 'engine', root / 'bin'
            for path in (source / 'deploy', source / 'web', engine, binary):
                path.mkdir(parents=True)
            for name in ('Dockerfile', 'Dockerfile.realtime'):
                (source / 'web' / name).write_text('FROM scratch\n')
            (source / 'web/pinned-source.txt').write_text('selected commit only')
            (source / 'deploy/release.sh').write_text('echo WRONG_ARCHIVED_ENGINE; exit 99\n')
            for name in ('release-env-policy.sh', 'release-remote.sh'):
                (source / 'deploy' / name).write_bytes((DEPLOY / name).read_bytes())
            (source / 'web/.env.production').write_text(
                'ACR_SERVER=registry.example.test\nACR_NAMESPACE=fixture\nACR_REPO=app\n'
                'ACR_USERNAME=fixture\nACR_PASSWORD=fixture-password\n'
                'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=fixture-key\n')
            fake = binary / 'docker'
            fake.write_text('''#!/usr/bin/env python3
import csv,json,os,sys
args=sys.argv[1:]
with open(os.environ['WQN_BUILD_TEST_LOG'],'a') as f:
    f.write(json.dumps({'args':args,'cwd':os.getcwd()})+'\\n')
if args[:2]==['buildx','inspect'] and '--bootstrap' not in args: sys.exit(1)
if args[:2]==['buildx','create']:
    for i,v in enumerate(args):
        if v=='--driver-opt':
            for field in next(csv.reader([args[i+1]],strict=True)):
                if '=' not in field:
                    print('invalid value '+repr(field)+', expecting k=v');sys.exit(17)
if args[:2]==['buildx','build']:
    assert open('pinned-source.txt').read()=='selected commit only'
print('fixture Docker success')
''')
            fake.chmod(0o700)
            metadata = core.build_engine_metadata('native')
            core.stage_build_engine(metadata, engine)
            bypass = 'localhost,127.0.0.1,::1,.example.test,quote"test'
            env = dict(os.environ, PATH=str(binary) + ':' + os.environ['PATH'],
                       WQN_OPS_MANAGED='1', WQN_OPS_SOURCE_DIR=str(source),
                       WQN_OPS_SOURCE_SHA='a' * 40, WQN_BUILD_PROXY='http://proxy.example.test:7893',
                       WQN_BUILD_NO_PROXY=bypass, WQN_BUILD_TEST_LOG=str(root / 'calls.jsonl'))
            result = subprocess.run(['bash', str(engine / 'release.sh'), 'fixture-tag', '--no-deploy'],
                                    cwd=source, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertNotIn('WRONG_ARCHIVED_ENGINE', result.stdout)
            calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
            creates = [c['args'] for c in calls if c['args'][:2] == ['buildx', 'create']]
            self.assertEqual(len(creates), 2)
            for args in creates:
                options = {}
                for i, arg in enumerate(args):
                    if arg == '--driver-opt':
                        fields = next(csv.reader([args[i + 1]], strict=True))
                        self.assertEqual(len(fields), 1)
                        key, value = fields[0].split('=', 1)
                        options[key] = value
                self.assertEqual(options['env.NO_PROXY'], bypass)
                self.assertEqual(options['env.no_proxy'], bypass)
            builds = [c for c in calls if c['args'][:2] == ['buildx', 'build']]
            self.assertEqual(len(builds), 2)
            self.assertTrue(all(c['cwd'] == str(source / 'web') for c in builds))
            self.assertFalse(any(c['args'][0] in ('pull', 'stop', 'run') for c in calls))

    def test_engine_snapshot_rejects_changes_after_recording_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            script = root / 'deploy/release.sh'
            script.write_text('echo original\n')
            with mock.patch.object(core, 'REPO', root):
                metadata = core.build_engine_metadata('native')
                script.write_text('echo changed\n')
                with self.assertRaisesRegex(core.OpsError, '发布工具已经变化'):
                    core.stage_build_engine(metadata, root)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = server.make_server(0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.base = 'http://127.0.0.1:%d' % self.server.server_port

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.console.pool.shutdown(wait=True)

    def request(self, path, body=None, **headers):
        req = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers=headers)
        return build_opener(ProxyHandler({})).open(req, timeout=5)

    def test_page_serves_and_escapes_no_secret_state(self):
        with self.request('/') as response:
            html = response.read().decode()
            self.assertIn('WQN', html)
            self.assertNotIn('__WQN_TOKEN__', html)
            self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])

    def test_api_requires_token_and_mutation_requires_matching_origin(self):
        with self.assertRaises(HTTPError) as exc:
            self.request('/api/config')
        self.assertEqual(exc.exception.code, 403)
        token = self.server.console.token
        with self.request('/api/config', **{'X-WQN-Token': token}) as response:
            self.assertEqual(json.load(response)['host'], 'aliyun')
        with self.assertRaises(HTTPError) as exc:
            self.request('/api/defer', {}, **{'X-WQN-Token': token, 'Content-Type': 'application/json', 'Origin': 'https://untrusted.example'})
        self.assertEqual(exc.exception.code, 403)

    def test_dns_rebinding_host_is_rejected(self):
        with self.assertRaises(HTTPError) as exc:
            self.request('/', Host='attacker.example')
        self.assertEqual(exc.exception.code, 403)


if __name__ == '__main__':
    unittest.main(verbosity=2)
