-- Run after the Word Study v1 and Word Pack v2 migrations inside one
-- rollback-only transaction. Any failed assertion aborts via ON_ERROR_STOP.

insert into auth.users (
  id, aud, role, email, encrypted_password, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values (
  '90000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'word-study-v1@example.invalid',
  '',
  now(),
  now(),
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.word_decks (
  id, user_id, title, source, is_system
) values (
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'Word Study v1 validation',
  'user',
  false
);

insert into public.word_entries (
  id, deck_id, word, normalized_word, meaning, sort_index
) values (
  '90000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000002',
  'baseline',
  'baseline',
  '基线',
  0
);

insert into public.study_sessions (
  id, user_id, domain, mode, purpose, ordering, scope, seed, snapshot,
  candidate_ids, candidate_items, create_request_id, create_fingerprint
) values (
  '90000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000001',
  'word',
  'random',
  'study',
  'guided_random_v1',
  '{"deck_ids":["90000000-0000-4000-8000-000000000002"],"include_mastered":false}'::jsonb,
  'validation_seed',
  '[]'::jsonb,
  array['90000000-0000-4000-8000-000000000003'::uuid],
  '[{"item_id":"90000000-0000-4000-8000-000000000003","deck_id":"90000000-0000-4000-8000-000000000002","ordinal":0}]'::jsonb,
  'session_request_00000001',
  repeat('a', 64)
);

do $$
declare
  v_first jsonb;
  v_replay jsonb;
  v_shown jsonb;
  v_count integer;
begin
  v_first := public.record_study_observation_v1(
    '90000000-0000-4000-8000-000000000001',
    null,
    'observation_request_0001',
    '90000000-0000-4000-8000-000000000004',
    0,
    '90000000-0000-4000-8000-000000000003',
    'unknown',
    'random',
    '2026-07-20T00:00:00Z'
  );
  if v_first ->> 'replayed' <> 'false'
     or v_first #>> '{progress,status}' <> 'learning'
     or v_first #>> '{progress,reviewed_count}' <> '1'
     or v_first #>> '{progress,unknown_count}' <> '1' then
    raise exception 'unexpected first observation result: %', v_first;
  end if;

  v_replay := public.record_study_observation_v1(
    '90000000-0000-4000-8000-000000000001',
    null,
    'observation_request_0001',
    '90000000-0000-4000-8000-000000000004',
    0,
    '90000000-0000-4000-8000-000000000003',
    'unknown',
    'random',
    '2026-07-20T00:00:00Z'
  );
  if v_replay ->> 'replayed' <> 'true'
     or v_replay ->> 'observation_id' <> v_first ->> 'observation_id' then
    raise exception 'idempotent replay changed result: %', v_replay;
  end if;

  select count(*) into v_count
  from public.word_review_events
  where study_observation_id = (v_first ->> 'observation_id')::uuid;
  if v_count <> 1 then
    raise exception 'legacy projection count was %, expected 1', v_count;
  end if;

  v_shown := public.record_study_observation_v1(
    '90000000-0000-4000-8000-000000000001',
    null,
    'observation_request_0002',
    '90000000-0000-4000-8000-000000000004',
    1,
    '90000000-0000-4000-8000-000000000003',
    'shown',
    'random',
    '2026-07-20T00:00:01Z'
  );
  if v_shown #>> '{progress,reviewed_count}' <> '1'
     or v_shown #>> '{progress,unknown_count}' <> '1' then
    raise exception 'shown mutated progress: %', v_shown;
  end if;

  begin
    perform public.record_study_observation_v1(
      '90000000-0000-4000-8000-000000000001',
      null,
      'observation_request_0002',
      '90000000-0000-4000-8000-000000000004',
      1,
      '90000000-0000-4000-8000-000000000003',
      'known',
      'random',
      '2026-07-20T00:00:01Z'
    );
    raise exception 'request ID reuse was accepted';
  exception
    when unique_violation then
      if sqlerrm <> 'STUDY_REQUEST_ID_REUSED' then
        raise;
      end if;
  end;

  select count(*) into v_count
  from public.word_mistake_links
  where user_id = '90000000-0000-4000-8000-000000000001'
    and word_entry_id = '90000000-0000-4000-8000-000000000003';
  if v_count <> 1 then
    raise exception 'wrong-word projection count was %, expected 1', v_count;
  end if;

  if (select next_sequence from public.study_sessions
      where id = '90000000-0000-4000-8000-000000000004') <> 2 then
    raise exception 'session sequence did not advance exactly once per observation';
  end if;

  if not exists (
    select 1 from public.word_change_log
    where deck_id = '90000000-0000-4000-8000-000000000002'
      and entity_kind in ('deck', 'entry', 'progress')
  ) then
    raise exception 'word changes were not appended to the monotonic feed';
  end if;

  update public.word_decks
  set is_active = false
  where id = '90000000-0000-4000-8000-000000000002';
  if not exists (
    select 1 from public.word_change_log
    where deck_id = '90000000-0000-4000-8000-000000000002'
      and entity_kind = 'deck'
      and operation = 'delete'
  ) then
    raise exception 'deck deactivation did not emit a tombstone';
  end if;
end;
$$;
