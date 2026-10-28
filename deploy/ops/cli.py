#!/usr/bin/env python3
"""Shared entry point for the UI, batch files and shell scripts."""
import argparse
import json
from pathlib import Path
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from ops import core
else:
    from . import core


def display(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WQN 发布与运维控制台；持久记录位于 SSH 目标主机')
    sub = parser.add_subparsers(dest='command', required=True)
    serve = sub.add_parser('serve')
    serve.add_argument('--port', type=int, default=8765)
    serve.add_argument('--ssh-host', default='aliyun')
    check = sub.add_parser('check')
    check.add_argument('--ref', default='HEAD')
    for name in ('status', 'history', 'capture', 'logs', 'env', 'env-check', 'env-preview', 'env-plan', 'rollback-plan', 'apply', 'operation'):
        p = sub.add_parser(name)
        p.add_argument('--ssh-host', default='aliyun')
        if name == 'logs':
            p.add_argument('--source', default='app', choices=['app', 'realtime', 'nginx-access', 'nginx-error', 'docker-daemon'])
            p.add_argument('--since', default='30m')
        if name in ('rollback-plan', 'apply', 'operation'):
            p.add_argument('id')
        if name in ('apply', 'env'):
            p.add_argument('--yes', action='store_true')
            p.add_argument('--compatibility-reviewed', action='store_true')
    release = sub.add_parser('release')
    release.add_argument('tag', nargs='?')
    release.add_argument('--tag', '-Tag', dest='named_tag')
    release.add_argument('--ref', default='HEAD')
    release.add_argument('--ssh-host', default='aliyun')
    release.add_argument('--rt-tag')
    release.add_argument('--skip-realtime', '-SkipRealtime', action='store_true')
    release.add_argument('--no-deploy', '-NoDeploy', action='store_true')
    release.add_argument('--engine', choices=['native', 'powershell'], default='native')
    release.add_argument('--yes', action='store_true')
    release.add_argument('--defer-reason')
    release.add_argument('--no-build-proxy', action='store_true')
    release.add_argument('--use-default-builder', action='store_true')
    release.add_argument('--recreate-builders', action='store_true')
    release.add_argument('--build-proxy')
    args = parser.parse_args(argv)
    try:
        if args.command == 'serve':
            from ops.server import serve
            serve(args.port, args.ssh_host)
        elif args.command == 'check':
            display(core.scan(args.ref))
        elif args.command in ('status', 'history'):
            display(core.rpc(args.command, args.ssh_host))
        elif args.command == 'capture':
            current = core.rpc('status', args.ssh_host)
            display(core.rpc('prepare', args.ssh_host, kind='baseline',
                             services=[s['service'] for s in current['services'] if s['running']]))
        elif args.command == 'logs':
            display(core.rpc('logs', args.ssh_host, source=args.source, since=args.since))
        elif args.command == 'env-check':
            # Same judgement as release: the unmodified file, for both services.
            # Filtering here would report success for a file release rejects.
            values = core.dotenv()
            selected = core.runtime_values(values=values, services=['app', 'realtime'])
            print('Validated %d App and %d Realtime environment variables; '
                  'no SSH connection or cloud changes.'
                  % (len(selected['app']), len(selected['realtime'])))
        elif args.command == 'env-preview':
            display(core.environment_plan(args.ssh_host, preview=True))
        elif args.command == 'env':
            plan = core.environment_plan(args.ssh_host)
            display(plan)
            if plan['status'] == 'no_changes':
                return 0
            if not args.yes and input('按上述差异重建 App？输入 APPLY 确认：') != 'APPLY':
                return 0
            core.rpc('apply', args.ssh_host, id=plan['id'])
            result = core.wait_operation(plan['id'], args.ssh_host)
            display(result)
            return 0 if result['status'] == 'verified' else 1
        elif args.command == 'env-plan':
            display(core.environment_plan(args.ssh_host))
        elif args.command == 'rollback-plan':
            display(core.rollback_plan(args.id, args.ssh_host))
        elif args.command == 'operation':
            display(core.rpc('operation', args.ssh_host, id=args.id))
        elif args.command == 'apply':
            if not args.yes:
                display(core.rpc('operation', args.ssh_host, id=args.id))
                if input('按上述计划执行？输入 APPLY 确认：') != 'APPLY':
                    return 0
            core.rpc('apply', args.ssh_host, id=args.id, compatibility_reviewed=args.compatibility_reviewed)
            result = core.wait_operation(args.id, args.ssh_host)
            display(result)
            return 0 if result['status'] == 'verified' else 1
        elif args.command == 'release':
            if not args.yes:
                report = core.scan(args.ref)
                print('候选：%s @ %s' % (args.ref, report['candidate']['sha']))
                for c in report['commits']:
                    print('  %s %s %s' % (c['commit_time'], c['sha'][:8], c['subject']))
                for item in report['omissions']:
                    print('候选内容待核对：%s，%d 个程序补丁，最近 %s' % (item['branch'], item['missing_count'], item['commit_time']))
                if input('构建并推送%s？输入 RELEASE 确认：' % ('后部署' if not args.no_deploy else '')) != 'RELEASE':
                    return 0
            options = []
            for enabled, flag in ((args.no_build_proxy, '-NoBuildProxy'),
                                  (args.use_default_builder, '-UseDefaultBuilder'),
                                  (args.recreate_builders, '-RecreateBuilder')):
                if enabled:
                    options.append(flag)
            if args.build_proxy:
                options += ['-BuildProxy', args.build_proxy]
            def progress(item):
                if item.get('log_line'):
                    print(item['log_line'], flush=True)
                elif item.get('id'):
                    print('[%s] %s' % (item['id'], item.get('status')), flush=True)
            result = core.release(ref=args.ref, host=args.ssh_host,
                                  tag=args.named_tag or args.tag, rt_tag=args.rt_tag,
                                  skip_realtime=args.skip_realtime, no_deploy=args.no_deploy,
                                  engine=args.engine, approve=True, defer_reason=args.defer_reason,
                                  callback=progress, build_options=options)
            display(result)
            return 0 if result['status'] in ('verified', 'pushed') else 1
    except (core.OpsError, KeyboardInterrupt) as exc:
        print('ERROR: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
