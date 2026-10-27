"""Loopback-only UI. SSH credentials stay in the operator's OS environment."""
from concurrent.futures import ThreadPoolExecutor
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import secrets
import threading
from urllib.parse import parse_qs, urlsplit
import uuid

from . import core

STATIC = Path(__file__).with_name('ui')


class Console:
    def __init__(self, host='aliyun'):
        self.host = core.validate_host(host)
        self.token = secrets.token_urlsafe(32)
        self.plans = {}
        self.jobs = {}
        self.guard = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='wqn-operation')

    def job(self, target):
        job_id = uuid.uuid4().hex
        self.jobs[job_id] = {'id': job_id, 'status': 'queued', 'created_at': core.now(), 'lines': []}

        def callback(value):
            data = self.jobs[job_id]
            if value.get('log_line'):
                data['lines'] = (data['lines'] + [value['log_line']])[-300:]
            if value.get('id'):
                data['operation_id'] = value['id']
            data['progress'] = value.get('status')

        def work():
            data = self.jobs[job_id]
            data['status'] = 'running'
            try:
                data['result'] = target(callback)
                data['status'] = 'completed'
            except Exception as exc:
                data['status'] = 'failed'
                data['error'] = str(exc) if isinstance(exc, core.OpsError) else '操作失败；请查询云端状态与任务记录'
            data['finished_at'] = core.now()

        self.pool.submit(work)
        return self.jobs[job_id]

    def get(self, path, query):
        q = lambda name, default=None: query.get(name, [default])[0]
        if path == '/api/config':
            return {'host': self.host, 'repo': str(core.REPO), 'version': 1}
        if path == '/api/git':
            return core.scan(q('ref', 'HEAD'))
        if path == '/api/context':
            return core.context(core.resolve(q('sha')), core.resolve(q('ref', 'HEAD')))
        if path == '/api/prs':
            return core.github_prs(q('ref', 'HEAD'))
        if path == '/api/cloud':
            return core.rpc('status', self.host)
        if path == '/api/history':
            return core.rpc('history', self.host)
        if path == '/api/decisions':
            return core.review_decisions(core.scan(q('ref', 'HEAD')), core.rpc('decisions', self.host))
        if path == '/api/operation':
            return core.rpc('operation', self.host, id=q('id'))
        if path == '/api/logs':
            return core.rpc('logs', self.host, source=q('source', 'app'), since=q('since', '30m'), tail=300)
        if path == '/api/job':
            if q('id') not in self.jobs:
                raise core.OpsError('本地任务不存在；可按操作 ID 查询云端历史')
            return self.jobs[q('id')]
        raise core.OpsError('未知接口')

    def post(self, path, body):
        if path == '/api/image/probe':
            return core.rpc('image_probe', self.host, timeout=40,
                            id=body.get('id'), service=body.get('service'))
        if path == '/api/refresh-git':
            core.command(['git', 'fetch', '--all', '--prune'], timeout=90)
            return core.scan(body.get('ref', 'HEAD'))
        if path == '/api/defer':
            # Recompute the fingerprint: never let the UI forge the reviewed set.
            report = core.scan(body.get('ref', 'HEAD'))
            item = next((o for o in report['omissions'] if o['fingerprint'] == body.get('fingerprint')), None)
            if not item:
                raise core.OpsError('分支内容已经变化，请刷新后重新核对')
            saved = core.rpc('defer', self.host, decision={**item, 'reason': body.get('reason', '')})
            return core.review_decisions(report, saved)
        if path == '/api/plan/env':
            return core.environment_plan(self.host, body.get('ref', 'HEAD'), body.get('services', ['app']))
        if path == '/api/capture':
            current = core.rpc('status', self.host)
            services = [s['service'] for s in current['services'] if s['running']]
            return core.rpc('prepare', self.host, kind='baseline', services=services)
        if path == '/api/plan/rollback':
            return core.rollback_plan(body.get('target_id'), self.host, body.get('services', ['app']))
        if path == '/api/plan/release':
            ref = body.get('ref', 'HEAD')
            report = core.scan(ref)
            services = ['app'] if body.get('skip_realtime') else ['app', 'realtime']
            core.runtime_values(report['candidate']['sha'], services)
            decisions = core.review_decisions(report, core.rpc('decisions', self.host))
            plan_id = uuid.uuid4().hex
            opts = {'ref': ref, 'host': self.host, 'skip_realtime': bool(body.get('skip_realtime')),
                    'no_deploy': bool(body.get('no_deploy')), 'approve': True}
            self.plans[plan_id] = {'options': opts, 'sha': report['candidate']['sha'],
                                   'env_hash': core.hashlib.sha256((core.REPO / 'web/.env.production').read_bytes()).hexdigest()}
            return {'id': plan_id, 'kind': 'release', 'status': 'planned',
                    'source': core.source_metadata(report), 'services': services,
                    'no_deploy': opts['no_deploy'], 'changes': [], 'created_at': core.now(),
                    'omissions': [o for o in report['omissions'] if o['fingerprint'] not in decisions]}
        if path == '/api/apply':
            plan_id = body.get('id')
            with self.guard:
                local = self.plans.get(plan_id)
                if local:
                    if core.resolve(local['options']['ref']) != local['sha']:
                        raise core.OpsError('候选分支已经变化，请重新生成发布计划')
                    env_hash = core.hashlib.sha256((core.REPO / 'web/.env.production').read_bytes()).hexdigest()
                    if env_hash != local['env_hash']:
                        raise core.OpsError('环境配置已经变化，请重新生成计划')
                    del self.plans[plan_id]
            if local:
                opts = dict(local['options'], defer_reason=body.get('defer_reason'))
                return self.job(lambda callback: core.release(**opts, callback=callback))
            if not isinstance(plan_id, str) or not core.re.fullmatch(r'[a-f0-9]{32}', plan_id):
                raise core.OpsError('无效的计划 ID')
            result = core.rpc('apply', self.host, id=plan_id,
                              compatibility_reviewed=body.get('compatibility_reviewed') is True)
            return self.job(lambda callback: core.wait_operation(result['id'], self.host, callback))
        raise core.OpsError('未知操作')


def make_server(port=8765, host='aliyun'):
    app = Console(host)

    class Handler(BaseHTTPRequestHandler):
        server_version = 'WQN-Console/1'

        def log_message(self, *_):
            pass

        def authorized_host(self):
            allowed = {'127.0.0.1:' + str(self.server.server_port),
                       'localhost:' + str(self.server.server_port)}
            return self.headers.get('Host', '') in allowed

        def send(self, status, value, mime='application/json; charset=utf-8'):
            content = json.dumps(value, ensure_ascii=False).encode() if isinstance(value, (dict, list)) else value
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(content)

        def api_auth(self, mutation=False):
            if not self.authorized_host():
                return False
            token = self.headers.get('X-WQN-Token', '')
            if not hmac.compare_digest(token, app.token):
                return False
            if mutation:
                origin = self.headers.get('Origin', '')
                allowed = {'http://127.0.0.1:' + str(self.server.server_port),
                           'http://localhost:' + str(self.server.server_port)}
                if origin not in allowed:
                    return False
            return self.headers.get('Sec-Fetch-Site', '') not in ('cross-site',)

        def do_GET(self):
            if not self.authorized_host():
                return self.send(403, {'error': '仅接受本机访问'})
            parsed = urlsplit(self.path)
            if parsed.path.startswith('/api/'):
                if not self.api_auth():
                    return self.send(403, {'error': '会话已失效，请刷新页面'})
                try:
                    return self.send(200, app.get(parsed.path, parse_qs(parsed.query)))
                except Exception as exc:
                    return self.send(400, {'error': str(exc) if isinstance(exc, core.OpsError) else '查询失败'})
            files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}
            if parsed.path not in files:
                return self.send(404, {'error': '页面不存在'})
            path = STATIC / files[parsed.path]
            data = path.read_bytes()
            if parsed.path == '/':
                data = data.replace(b'__WQN_TOKEN__', app.token.encode('ascii'))
            return self.send(200, data, mimetypes.guess_type(str(path))[0] + '; charset=utf-8')

        def do_POST(self):
            if not self.api_auth(mutation=True):
                return self.send(403, {'error': '请求来源或会话不匹配'})
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.send(415, {'error': '请求必须为 JSON'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > 65536:
                    return self.send(413, {'error': '请求大小不正确'})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, OSError):
                return self.send(400, {'error': '无效请求'})
            try:
                return self.send(200, app.post(urlsplit(self.path).path, body))
            except Exception as exc:
                return self.send(400, {'error': str(exc) if isinstance(exc, core.OpsError) else '操作失败；请查询云端状态'})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.console = app
    return server


def serve(port=8765, host='aliyun'):
    server = make_server(port, host)
    print('WQN 发布工作台：http://127.0.0.1:%d' % server.server_port, flush=True)
    print('云端目标：%s；记录与配置快照保存在云端。' % host, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.console.pool.shutdown(wait=True)
