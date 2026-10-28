#!/usr/bin/env python3
"""Real PostgreSQL regression matrix; requires the migration in an isolated DB.

PGHOST=/tmp PGPORT=55439 PGDATABASE=wqn_opencode_control_20261017 python3 scripts/test-opencode-control-db.py
Creates only UUID-scoped fixtures. Never accepts a non-test database name.
"""
import concurrent.futures
import json
import os
import subprocess
import uuid

database = os.environ.get('PGDATABASE', '')
if not database.startswith('wqn_opencode_control_'):
    raise SystemExit('Set PGDATABASE to a dedicated wqn_opencode_control_* database')
checks = 0

def sql(query):
    result = subprocess.run(['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', database], input=query, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def call(action, payload):
    encoded = json.dumps(payload).replace("'", "''")
    return json.loads(sql(f"select public.opencode_agent_control_v1('{action}','{encoded}'::jsonb);"))

def check(value, label):
    global checks
    checks += 1
    if not value:
        raise AssertionError(label)

def denied(action, payload, expected):
    try:
        call(action, payload)
    except RuntimeError as error:
        check(expected in str(error), f'{action} expected {expected}: {error}')
    else:
        raise AssertionError(f'{action} unexpectedly allowed')

def arm(user=None, limits=None):
    user = user or str(uuid.uuid4())
    device = str(uuid.uuid4())
    sql(f"insert into public.esp32_devices(id) values('{device}');")
    budget = dict(maxInputTokens=100,maxOutputTokens=10,maxTotalTokens=500,maxProviderRequests=4,maxSteps=3,maxDurationMs=60000,maxFallbacksPer24Hours=3,maxUserTokensPer24Hours=2000,cooldownMs=600000,quotaGroups={'p/m':'primary','q/m':'backup'})
    budget.update(limits or {})
    payload = dict(userId=user,deviceId=device,requestId=uuid.uuid4().hex[:16],sessionId='ses_'+uuid.uuid4().hex,scope='a'*64,policy=dict(primary='p/m',fallback='q/m',limits=budget))
    return call('arm',payload),payload

def reserve(task, model='p/m', **overrides):
    payload = dict(taskId=task['id'],attemptId=str(uuid.uuid4()),model=model,kind='primary',inputTokens=100,outputTokens=10)
    payload.update(overrides)
    return call('reserve',payload),payload

t,payload = arm()
same = call('arm',{**payload,'policy':{**payload['policy'],'primary':'evil/model'}})
check(same['id']==t['id'] and same['policy']['primary']=='p/m','request replay retains policy snapshot')
_,attempt = reserve(t)
denied('reserve',attempt,'duplicate key')
check(call('lookup',dict(scope='a'*64,sessionId=t['session_id']))['request_count']==1,'duplicate reserve rolled back')
call('fallback',dict(taskId=t['id'],reason='rate_limited'))
_,backup = reserve(t,'q/m')
denied('fallback',dict(taskId=t['id'],reason='quota_exhausted'),'FALLBACK_UNSAFE')
call('settle',dict(taskId=t['id'],attemptId=backup['attemptId'],usedTokens=20))
call('settle',dict(taskId=t['id'],attemptId=backup['attemptId'],usedTokens=0))
row=call('lookup',dict(scope='a'*64,sessionId=t['session_id']))
check(row['reserved_tokens']==130,'unknown primary retains 110; backup settles once to 20')

for flag in ['output','tool']:
    t,_=arm();reserve(t);call('activity',dict(taskId=t['id'],**{flag:True}))
    denied('fallback',dict(taskId=t['id'],reason='quota_exhausted'),'FALLBACK_UNSAFE')
t,_=arm();reserve(t);call('cancel',dict(taskId=t['id']))
denied('fallback',dict(taskId=t['id'],reason='rate_limited'),'TASK_STOPPED')
denied('reserve',dict(taskId=t['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'TASK_STOPPED')

t,_=arm(limits={'quotaGroups':{'p/m':'shared','q/m':'shared'}});reserve(t)
denied('fallback',dict(taskId=t['id'],reason='quota_exhausted'),'SHARED_QUOTA')
t,_=arm();reserve(t)
denied('fallback',dict(taskId=t['id'],reason='local_rate_limited'),'FALLBACK_INELIGIBLE')
t,_=arm()
call('fallback',dict(taskId=t['id'],reason='model_unavailable'))
reserve(t,'q/m')
check(call('lookup',dict(scope='a'*64,sessionId=t['session_id']))['fallback_count']==1,'preflight fallback consumes allowance')

# Two independent connections race for the same user's sole fallback slot.
user=str(uuid.uuid4());first,_=arm(user);second,_=arm(user)
reserve(first);reserve(second)
def switch(task):
    try:return call('fallback',dict(taskId=task['id'],reason='rate_limited'))
    except RuntimeError as error:return str(error)
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    results=list(pool.map(switch,[first,second]))
check(sum(isinstance(r,dict) for r in results)==1,'concurrent fallback admits exactly one')
check(any('FALLBACK_BUSY' in str(r) for r in results),'concurrent fallback refuses other session')

# User-wide token reservation also races across devices and sessions.
user=str(uuid.uuid4());first,_=arm(user,{'maxTotalTokens':110,'maxUserTokensPer24Hours':150});second,_=arm(user,{'maxTotalTokens':110,'maxUserTokensPer24Hours':150})
def send(task):
    try:return reserve(task)[0]
    except RuntimeError as error:return str(error)
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    results=list(pool.map(send,[first,second]))
check(sum(isinstance(r,dict) for r in results)==1,'concurrent user budget admits exactly one')
check(any('USER_BUDGET_EXHAUSTED' in str(r) for r in results),'other device cannot overspend')

t,_=arm(limits={'maxProviderRequests':1});reserve(t)
denied('reserve',dict(taskId=t['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'TASK_BUDGET_EXHAUSTED')
t,_=arm();sql(f"update public.opencode_agent_tasks set deadline=now()-interval '1 second' where id='{t['id']}';")
denied('reserve',dict(taskId=t['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'TASK_STOPPED')
# Independent per-request caps and step bounds.
for bound in [dict(inputTokens=101), dict(outputTokens=11)]:
    t,_=arm()
    denied('reserve',{**dict(taskId=t['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),**bound},'REQUEST_BUDGET_EXHAUSTED')
t,_=arm(limits={'maxSteps':1});reserve(t)
denied('reserve',dict(taskId=t['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'TASK_BUDGET_EXHAUSTED')

# Fallback quota counts the switch timestamp, even if the task predates the window.
user=str(uuid.uuid4());t,_=arm(user,{'maxFallbacksPer24Hours':1})
call('fallback',dict(taskId=t['id'],reason='model_unavailable'))
call('finish',dict(taskId=t['id'],state='completed'))
sql(f"update public.opencode_agent_tasks set created_at=now()-interval '25 hours' where id='{t['id']}';")
t2,_=arm(user,{'maxFallbacksPer24Hours':1})
denied('fallback',dict(taskId=t2['id'],reason='model_unavailable'),'FALLBACK_WINDOW_EXHAUSTED')

# A fresh client/process still sees reservations. Unknown tasks retain them
# beyond the rolling window rather than releasing on a lease timeout.
t,payload=arm(limits={'maxTotalTokens':110,'maxUserTokensPer24Hours':150});reserve(t)
call('finish',dict(taskId=t['id'],state='unknown'))
sql(f"update public.opencode_agent_tasks set created_at=now()-interval '25 hours' where id='{t['id']}'; update public.opencode_provider_attempts set created_at=now()-interval '25 hours' where task_id='{t['id']}';")
t2,_=arm(payload['userId'],{'maxTotalTokens':110,'maxUserTokensPer24Hours':150})
denied('reserve',dict(taskId=t2['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'USER_BUDGET_EXHAUSTED')
call('finish',dict(taskId=t['id'],state='completed'))
call('finish',dict(taskId=t['id'],state='unknown'))
check(call('lookup',dict(scope='a'*64,sessionId=t['session_id']))['state']=='completed','late terminal writes cannot downgrade settled task')

t,payload=arm()
other={**payload,'deviceId':str(uuid.uuid4()),'requestId':uuid.uuid4().hex[:16]}
sql(f"insert into public.esp32_devices(id) values('{other['deviceId']}');")
denied('arm',other,'opencode_task_session_active')
call('failure',dict(taskId=t['id'],reason='quota_exhausted',status=403,code='insufficient_balance'))
row=call('lookup',dict(scope='a'*64,sessionId=t['session_id']))
check(row['error_kind']=='quota_exhausted' and row['provider_status']==403,'provider classification persists even without a safe fallback')

# Device removal cannot erase the user's token ledger.
t,payload=arm(limits={'maxTotalTokens':110,'maxUserTokensPer24Hours':150});reserve(t)
sql(f"delete from public.esp32_devices where id='{payload['deviceId']}';")
t2,_=arm(payload['userId'],{'maxTotalTokens':110,'maxUserTokensPer24Hours':150})
denied('reserve',dict(taskId=t2['id'],attemptId=str(uuid.uuid4()),model='p/m',kind='primary',inputTokens=100,outputTokens=10),'USER_BUDGET_EXHAUSTED')

# Child identity is immutable across new parent admissions and process restarts.
t,payload=arm();child='ses_'+uuid.uuid4().hex
call('bind',dict(taskId=t['id'],sessionId=child))
row=call('lookup',dict(scope='a'*64,sessionId=child))
check(row['id']==t['id'] and row['tool_seen'],'child maps to original task and disables fallback')
reserve(t)
denied('fallback',dict(taskId=t['id'],reason='rate_limited'),'FALLBACK_UNSAFE')
call('finish',dict(taskId=t['id'],state='completed'))
new_payload={**payload,'requestId':uuid.uuid4().hex[:16]}
new_task=call('arm',new_payload)
check(call('lookup',dict(scope='a'*64,sessionId=child))['id']==t['id'],'new parent task cannot steal old child')
denied('bind',dict(taskId=new_task['id'],sessionId=child),'CHILD_ALREADY_BOUND')

t,payload=arm()
call('failure',dict(taskId=t['id'],model='p/m',reason='rate_limited',status=429,retryAfterMs=1200000))
check(sql(f"select until_at>now()+interval '19 minutes' from public.opencode_model_cooldowns where user_id='{payload['userId']}' and model='p/m';")=='t','provider Retry-After can extend the configured cooldown')

for role in ['anon','authenticated']:
    try:sql(f"set role {role}; select public.opencode_agent_control_v1('lookup','{{}}');")
    except RuntimeError as error:check('permission denied' in str(error),f'{role} cannot call service RPC')
    else:raise AssertionError(f'{role} accessed budget control')
print(f'OpenCode PostgreSQL: {checks} checks passed')
