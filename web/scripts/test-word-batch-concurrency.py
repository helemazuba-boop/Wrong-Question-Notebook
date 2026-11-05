#!/usr/bin/env python3
"""Exercise real single/batch RPC lock ordering in an explicitly isolated test DB.

Requires the normal schema and long-sequence migrations. Test fixtures persist
only in the named review DB; the caller creates/drops that DB. No production URL
or credentials are consumed. --expect-deadlock is the pre-fix negative receipt.
"""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import time


OWNER = 'a1000000-0000-4000-8000-000000000001'
DEVICE = 'a1000000-0000-4000-8000-000000000010'
ITEM = 'a1000000-0000-4000-8000-000000000030'


def command(args):
    return ['docker', 'exec', '-i', '-u', 'postgres', args.container,
            'psql', '-X', '-A', '-t', '-d', args.database,
            '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']


def execute(args, sql):
    return subprocess.run(command(args), input=sql, text=True, capture_output=True, timeout=15)


def checked(args, sql):
    result = execute(args, sql)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def start(args, sql):
    process = subprocess.Popen(command(args), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    process.stdin.write(sql)
    process.stdin.close()
    process.stdin = None
    return process


def wait_ready(process):
    prefix = ''
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not select.select([process.stdout], [], [], 0.1)[0]:
            continue
        block = os.read(process.stdout.fileno(), 4096)
        prefix += block.decode('utf-8')
        if 'READY_A' in prefix:
            return prefix
        if not block:
            break
    raise RuntimeError('single RPC lock owner did not become ready: ' + prefix)


def run_case(args, case):
    sid = f'a1000000-0000-4000-8000-{90 + case:012d}'
    # Distinct request IDs exercise a single call racing either the first or
    # second item of the batch. The latter also rejects a naive fix that merely
    # removes the batch row lock but acquires request locks progressively.
    ids = [f'word_batch_concurrency_{case}_{index:04d}' for index in range(case + 1)]
    target = ids[-1]
    checked(args, f"""
insert into public.study_sessions (
 id,user_id,device_id,domain,mode,purpose,ordering,scope,seed,snapshot,
 candidate_items,candidate_count,optional_count,create_request_id,create_fingerprint
) select '{sid}',user_id,device_id,'word','sequential','study','sequential',scope,
 'concurrency_seed',snapshot,candidate_items,candidate_count,optional_count,
 'concurrency_session_{case:04d}',repeat('9',64)
from public.study_sessions where id='a1000000-0000-4000-8000-000000000070';
""")
    app_a, app_b = f'word_lock_review_{case}_single', f'word_lock_review_{case}_batch'
    single = fr"""
set application_name='{app_a}';
set deadlock_timeout='100ms';
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
 '{OWNER}:{DEVICE}:{target}',0::bigint));
\echo READY_A
do $$ declare deadline timestamptz=clock_timestamp()+interval '7 seconds';
begin loop
 perform pg_stat_clear_snapshot();
 exit when exists (select 1 from pg_stat_activity where application_name='{app_b}' and wait_event_type='Lock');
 if clock_timestamp()>deadline then raise exception 'batch did not reach the lock barrier'; end if;
 perform pg_sleep(0.01);
end loop; end $$;
select public.record_study_observation_v1('{OWNER}','{DEVICE}','{target}','{sid}',
 {case},'{ITEM}','shown','sequential','2026-11-05T12:00:00Z');
commit;
"""
    observations = [dict(request_id=request, sequence=index, item_id=ITEM,
                         action='shown', mode='sequential', occurred_at='2026-11-05T12:00:00Z')
                    for index, request in enumerate(ids)]
    batch = f"""
set application_name='{app_b}';
set deadlock_timeout='100ms';
begin;
select public.record_word_study_observation_batch_v1('{OWNER}','{DEVICE}','{sid}',
 '{json.dumps(observations)}'::jsonb);
commit;
"""
    first = start(args, single)
    second = None
    try:
        prefix = wait_ready(first)
        second = start(args, batch)
        rest, _ = first.communicate(timeout=12)
        other, _ = second.communicate(timeout=12)
        single_output = prefix + rest
        deadlock = '40P01' in single_output + other or 'deadlock detected' in single_output + other
        timed_out = '55P03' in single_output + other or '57014' in single_output + other
        expected_single = first.returncode == 0 or (case == 1 and 'STUDY_SEQUENCE_GAP' in single_output)
        count = int(checked(args, f"select count(*) from public.study_observations where session_id='{sid}';"))
        next_sequence = int(checked(args, f"select next_sequence from public.study_sessions where id='{sid}';"))
        passed = deadlock if args.expect_deadlock else (
            not deadlock and not timed_out and expected_single and second.returncode == 0 and
            count == len(ids) and next_sequence == len(ids))
        return dict(case=case, passed=passed, deadlock=deadlock, timed_out=timed_out,
                    single_returncode=first.returncode, batch_returncode=second.returncode,
                    observations=count, next_sequence=next_sequence,
                    single_output=single_output, batch_output=other)
    finally:
        for process in (first, second):
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


def run_item_case(args):
    """Two sessions judge the same two items in the opposite order."""
    sids = ['a1000000-0000-4000-8000-000000000092',
            'a1000000-0000-4000-8000-000000000093']
    second_item = 'a1000000-0000-4000-8000-000000000032'
    for index, sid in enumerate(sids):
        checked(args, f"""
insert into public.study_sessions (
 id,user_id,device_id,domain,mode,purpose,ordering,scope,seed,snapshot,
 candidate_items,candidate_count,optional_count,create_request_id,create_fingerprint
) select '{sid}',user_id,device_id,'word','sequential','study','sequential',scope,
 'item_concurrency_seed',snapshot,candidate_items,candidate_count,optional_count,
 'item_concurrency_session_{index:04d}',repeat('8',64)
from public.study_sessions where id='a1000000-0000-4000-8000-000000000070';
""")
    checked(args, """
create function public.word_review_test_barrier() returns trigger
language plpgsql as $$ declare deadline timestamptz=clock_timestamp()+interval '7 seconds';
begin
 if new.request_id='word_item_concurrency_a_0000' then
  raise notice 'READY_A';
  loop
   perform pg_stat_clear_snapshot();
   exit when exists (select 1 from pg_stat_activity
      where application_name='word_item_review_b' and wait_event_type='Lock');
   if clock_timestamp()>deadline then raise exception 'item batch did not reach lock barrier'; end if;
   perform pg_sleep(0.01);
  end loop;
 end if;
 return new;
end $$;
create trigger word_review_test_barrier after insert on public.study_observations
for each row execute function public.word_review_test_barrier();
""")
    statements = []
    for index, sid in enumerate(sids):
        label = 'a' if index == 0 else 'b'
        items = [ITEM, second_item] if index == 0 else [second_item, ITEM]
        facts = [dict(request_id=f'word_item_concurrency_{label}_{position:04d}',
                      sequence=position, item_id=item, action='known', mode='sequential',
                      occurred_at='2026-11-05T12:00:00Z') for position, item in enumerate(items)]
        statements.append(f"""
set application_name='word_item_review_{label}';
set deadlock_timeout='100ms';
begin;
select public.record_word_study_observation_batch_v1('{OWNER}','{DEVICE}','{sid}',
 '{json.dumps(facts)}'::jsonb);
commit;
""")
    first = start(args, statements[0])
    second = None
    try:
        prefix = wait_ready(first)
        second = start(args, statements[1])
        rest, _ = first.communicate(timeout=12)
        other, _ = second.communicate(timeout=12)
        output = prefix + rest
        deadlock = '40P01' in output + other or 'deadlock detected' in output + other
        timed_out = '55P03' in output + other or '57014' in output + other
        states = [checked(args, f"select next_sequence from public.study_sessions where id='{sid}';")
                  for sid in sids]
        count = int(checked(args, f"select count(*) from public.study_observations where session_id in ('{sids[0]}','{sids[1]}');"))
        passed = deadlock if args.expect_deadlock else (
            not deadlock and not timed_out and first.returncode == second.returncode == 0 and
            states == ['2', '2'] and count == 4)
        return dict(case='reversed-items', passed=passed, deadlock=deadlock, timed_out=timed_out,
                    first_returncode=first.returncode, second_returncode=second.returncode,
                    observations=count, session_sequences=states,
                    first_output=output, second_output=other)
    finally:
        for process in (first, second):
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
        checked(args, 'drop trigger word_review_test_barrier on public.study_observations; '
                'drop function public.word_review_test_barrier();')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--expect-deadlock', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.database.startswith('wqn_word_review_'):
        parser.error('use an isolated wqn_word_review_* database')
    fixture = Path(__file__).resolve().parents[1]/'supabase/tests/database/word-study-long-sequence.test.sql'
    prefix = fixture.read_text().split('do $$', 1)[0].replace('begin;', '', 1)
    checked(args, prefix)
    results = [run_case(args, case) for case in (0, 1)] + [run_item_case(args)]
    args.output.write_text(json.dumps(results, indent=2)+'\n')
    for result in results:
        print(json.dumps({key: value for key, value in result.items() if not key.endswith('_output')}))
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
