-- Run after all migrations inside one rollback-only transaction. Any failed
-- assertion aborts via ON_ERROR_STOP.
--
-- Covers 20260823000000_study_skip_tombstone_relax_v1.sql (Candidate A',
-- minimal tombstone contract): the skip endpoints must retire a terminally
-- rejected observation from identity fields alone, deriving action/mode/
-- occurred_at server-side.

begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values (
  '92000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'skip-tombstone-relax@example.invalid',
  '',
  now(),
  now(),
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.study_sessions (
  id, user_id, domain, mode, purpose, ordering, scope, seed, snapshot,
  candidate_items, candidate_count, optional_count,
  create_request_id, create_fingerprint
) values
  ('92000000-0000-4000-8000-000000000002',
   '92000000-0000-4000-8000-000000000001',
   'word', 'random', 'study', 'guided_random_v1',
   '{"deck_ids":[]}'::jsonb, 'seed_skip_word',
   '[]'::jsonb, '[]'::jsonb, 0, 0,
   'session_create_word_001', repeat('a', 64)),
  ('92000000-0000-4000-8000-000000000003',
   '92000000-0000-4000-8000-000000000001',
   'note', 'recent', 'study', 'sequential_note_v1',
   '{"notebook_ids":[]}'::jsonb, 'seed_skip_note',
   '[]'::jsonb, '[]'::jsonb, 0, 0,
   'session_create_note_001', repeat('b', 64));

-- 1. Word: a fully minimal tombstone (null placeholders) is accepted, stores
--    the session-derived mode, and clamps occurred_at to server time.
do $$
declare
  v_result jsonb;
  v_row public.study_observations%rowtype;
begin
  v_result := public.skip_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    null,
    'tombstone_word_req_0001',
    '92000000-0000-4000-8000-000000000002',
    0,
    '92000000-0000-4000-8000-000000000099',
    null, -- p_action placeholder
    null, -- p_mode placeholder
    null  -- p_occurred_at placeholder
  );
  if v_result ->> 'action' <> 'skipped'
     or v_result ->> 'projection_applied' <> 'false' then
    raise exception 'minimal word tombstone rejected: %', v_result;
  end if;
  select * into v_row
  from public.study_observations
  where request_id = 'tombstone_word_req_0001';
  if v_row.mode <> 'random' then
    raise exception 'tombstone mode was not derived from session: %', v_row.mode;
  end if;
  if v_row.occurred_at is null or v_row.occurred_at > now() then
    raise exception 'tombstone occurred_at was not defaulted to server time';
  end if;
end $$;

-- 2. Word: replaying the same request id with a DIFFERENT placeholder mode
--    must return the stored result (mode left the idempotency comparison).
do $$
declare
  v_replay jsonb;
begin
  v_replay := public.skip_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    null,
    'tombstone_word_req_0001',
    '92000000-0000-4000-8000-000000000002',
    0,
    '92000000-0000-4000-8000-000000000099',
    'known',      -- different placeholder than before
    'dictionary', -- different placeholder than before
    now()
  );
  if v_replay ->> 'replayed' <> 'true' then
    raise exception 'placeholder mode turned replay into reuse conflict: %', v_replay;
  end if;
end $$;

-- 3. Word: the next sequence also retires via a placeholder-only tombstone,
--    and the actor check no longer compares mode against the input.
do $$
declare
  v_next jsonb;
begin
  v_next := public.skip_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    null,
    'tombstone_word_req_0002',
    '92000000-0000-4000-8000-000000000002',
    1,
    '92000000-0000-4000-8000-000000000099',
    null,
    'sequential', -- deliberately wrong vs session mode 'random': must be ignored
    null
  );
  if v_next ->> 'action' <> 'skipped' then
    raise exception 'second minimal tombstone failed: %', v_next;
  end if;
  if (select next_sequence from public.study_sessions
      where id = '92000000-0000-4000-8000-000000000002') <> 2 then
    raise exception 'session did not advance exactly once per tombstone';
  end if;
end $$;

-- 4. Word: actor ownership stays strict even under relaxation.
do $$
begin
  perform public.skip_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-0000000000aa', -- foreign device
    'tombstone_word_req_0003',
    '92000000-0000-4000-8000-000000000002',
    2,
    '92000000-0000-4000-8000-000000000099',
    null, null, null
  );
  raise exception 'actor mismatch was accepted under relaxed tombstone';
exception
  when others then
    if sqlerrm <> 'STUDY_SESSION_ACTOR_MISMATCH' then
      raise;
    end if;
end $$;

-- 5. Word: identity guards stay strict (short request id).
do $$
begin
  perform public.skip_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    null,
    'short',
    '92000000-0000-4000-8000-000000000002',
    2,
    '92000000-0000-4000-8000-000000000099',
    null, null, null
  );
  raise exception 'malformed request id was accepted under relaxed tombstone';
exception
  when others then
    if sqlerrm <> 'INVALID_STUDY_OBSERVATION' then
      raise;
    end if;
end $$;

-- 6. Note: the same relaxations hold for the note tombstone.
do $$
declare
  v_result jsonb;
  v_mode text;
begin
  v_result := public.skip_note_study_observation_v1(
    '92000000-0000-4000-8000-000000000001',
    null,
    'tombstone_note_req_0001',
    '92000000-0000-4000-8000-000000000003',
    0,
    '92000000-0000-4000-8000-000000000098',
    null, null, null
  );
  if v_result ->> 'action' <> 'skipped'
     or v_result ->> 'projection_applied' <> 'false' then
    raise exception 'minimal note tombstone rejected: %', v_result;
  end if;
  select mode into v_mode
  from public.study_observations
  where request_id = 'tombstone_note_req_0001';
  if v_mode <> 'recent' then
    raise exception 'note tombstone mode was not derived from session: %', v_mode;
  end if;
end $$;

rollback;
