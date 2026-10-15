#!/usr/bin/env python3
"""Write an ephemeral E2E environment without printing credentials."""
import json
import os
import pathlib
import secrets
import shlex
import sys
from urllib.parse import urlparse

repo = pathlib.Path(__file__).resolve().parents[3]
local = repo / '.ci-local'
workdir = pathlib.Path(os.getenv('WQN_CI_SUPABASE_WORKDIR', str(local / 'supabase')))
status = json.loads((workdir / 'status.json').read_text())
api = urlparse(status['API_URL'])
if api.scheme != 'http' or api.hostname not in ('127.0.0.1', 'localhost') or not api.port:
    sys.exit('E2E upstream must be a local HTTP Supabase API with an explicit port')
public_key = status.get('ANON_KEY') or status.get('PUBLISHABLE_KEY')
server_key = status.get('SERVICE_ROLE_KEY') or status.get('SECRET_KEY')
if not public_key or not server_key or public_key == server_key:
    sys.exit('Local Supabase did not return distinct public and server credentials')
values = {
    'NEXT_PUBLIC_SUPABASE_URL': 'https://supabase.e2e.test:8444',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY': public_key,
    'SUPABASE_SECRET_KEY': server_key,
    'WQN_SUPABASE_EXPECTED_HOST': 'supabase.e2e.test',
    'SITE_URL': 'https://wqn.e2e.test:8443',
    'WQN_E2E_BASE_URL': 'https://wqn.e2e.test:8443',
    'NODE_EXTRA_CA_CERTS': str(local / 'certs/ca.crt'),
    'PLAYWRIGHT_FIREFOX_POLICIES_JSON': str(local / 'certs/firefox-policies.json'),
    'NEXT_TELEMETRY_DISABLED': '1',
    'CRON_SECRET': secrets.token_urlsafe(32),
    'WQN_E2E_SUPABASE_PORT': str(api.port),
}
os.umask(0o077)
(local / 'e2e.env').write_text(''.join(f'export {key}={shlex.quote(value)}\n' for key, value in values.items()))
if os.getenv('GITHUB_ENV'):
    for credential in (public_key, server_key, values['CRON_SECRET']):
        print(f'::add-mask::{credential}', flush=True)
    with open(os.environ['GITHUB_ENV'], 'a') as handle:
        handle.write(''.join(f'{key}={value}\n' for key, value in values.items()))
