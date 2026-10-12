#!/usr/bin/env python3
"""Replay the real RPC-guard migration against stored LF/CRLF function bodies."""
import json
import os
import pathlib
import subprocess
import sys
from urllib.parse import unquote, urlparse

web_root = pathlib.Path(__file__).resolve().parents[2]
status = json.loads(pathlib.Path(sys.argv[1]).read_text())
database = urlparse(status['DB_URL'])
if database.hostname not in ('127.0.0.1', 'localhost') or not database.port:
    sys.exit('Account guard regression requires an isolated local database')

migration = web_root / 'supabase/migrations/20261012000000_account_authorization.sql'
source = migration.read_text()
start = '-- BEGIN_ACTIVE_ACCOUNT_RPC_GUARD'
end = '-- END_ACTIVE_ACCOUNT_RPC_GUARD'
if source.count(start) != 1 or source.count(end) != 1:
    sys.exit('Account guard migration markers are missing or ambiguous')
guard = source.split(start, 1)[1].split(end, 1)[0]
fixtures = pathlib.Path(__file__).with_name('account-guard-fixtures.sql').read_text()
setup, verify = fixtures.split('-- APPLY_REAL_ACCOUNT_GUARD_MIGRATION', 1)
environment = {
    **os.environ,
    'PGHOST': database.hostname,
    'PGPORT': str(database.port),
    'PGUSER': unquote(database.username or ''),
    'PGPASSWORD': unquote(database.password or ''),
    'PGDATABASE': unquote(database.path.lstrip('/')),
}
result = subprocess.run(
    ['psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1'],
    input=setup + guard + verify,
    text=True,
    env=environment,
)
sys.exit(result.returncode)
