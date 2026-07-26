-- Run after the Word Study v1 and Word Pack v2 migrations inside one
-- rollback-only transaction. Any failed assertion aborts via ON_ERROR_STOP.

begin;

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

insert into public.word_packs (
  id, deck_id, revision, schema_version, format, compression, storage_path,
  sha256, byte_size, entry_count, status
) values
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 1, 2, 'jsonl', 'none', 'word-packs/1', repeat('1', 64), 1, 1, 'ready'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', 2, 2, 'jsonl', 'none', 'word-packs/2', repeat('2', 64), 1, 1, 'ready'),
  ('91000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000002', 3, 2, 'jsonl', 'none', 'word-packs/3', repeat('3', 64), 1, 1, 'ready'),
  ('91000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000002', 4, 2, 'jsonl', 'none', 'word-packs/4', repeat('4', 64), 1, 1, 'ready');

insert into public.study_sessions (
  id, user_id, domain, mode, purpose, ordering, scope, seed, snapshot,
  candidate_items, candidate_count, optional_count,
  create_request_id, create_fingerprint
) values (
  '90000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000001',
  'word',
  'random',
  'study',
  'guided_random_v1',
  '{"deck_ids":["90000000-0000-4000-8000-000000000002"],"include_mastered":false}'::jsonb,
  'validation_seed',
  '[{"deck_id":"90000000-0000-4000-8000-000000000002","content_revision":1,"pack_revision":1,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb,
  '[{"item_id":"90000000-0000-4000-8000-000000000003","deck_id":"90000000-0000-4000-8000-000000000002","ordinal":0}]'::jsonb,
  1,
  1,
  'session_request_00000001',
  repeat('a', 64)
);

do $$
declare
  v_first jsonb;
  v_replay jsonb;
  v_shown jsonb;
  v_stale jsonb;
  v_future jsonb;
  v_skipped jsonb;
  v_count integer;
  v_new_session public.study_sessions%rowtype;
  v_replayed_session public.study_sessions%rowtype;
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
     or v_first ->> 'projection_applied' <> 'true'
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
     or v_shown ->> 'projection_applied' <> 'false'
     or v_shown #>> '{progress,unknown_count}' <> '1' then
    raise exception 'shown mutated progress: %', v_shown;
  end if;

  v_stale := public.record_study_observation_v1(
    '90000000-0000-4000-8000-000000000001',
    null,
    'observation_request_0003',
    '90000000-0000-4000-8000-000000000004',
    2,
    '90000000-0000-4000-8000-000000000003',
    'known',
    'random',
    '2000-01-01T00:00:00Z'
  );
  if v_stale ->> 'projection_applied' <> 'false'
     or v_stale #>> '{progress,reviewed_count}' <> '1' then
    raise exception 'stale observation regressed progress: %', v_stale;
  end if;

  v_future := public.record_study_observation_v1(
    '90000000-0000-4000-8000-000000000001',
    null,
    'observation_request_0004',
    '90000000-0000-4000-8000-000000000004',
    3,
    '90000000-0000-4000-8000-000000000003',
    'unknown',
    'random',
    now() + interval '10 years'
  );
  if v_future ->> 'projection_applied' <> 'true'
     or (select last_reviewed_at > now() from public.word_progress
         where user_id = '90000000-0000-4000-8000-000000000001'
           and word_entry_id = '90000000-0000-4000-8000-000000000003') then
    raise exception 'future observation was not clamped: %', v_future;
  end if;

  v_skipped := public.skip_study_observation_v1(
    '90000000-0000-4000-8000-000000000001', null,
    'observation_request_skip1',
    '90000000-0000-4000-8000-000000000004', 4,
    '90000000-0000-4000-8000-000000000003', 'known', 'random', now()
  );
  if v_skipped ->> 'action' <> 'skipped'
     or v_skipped ->> 'projection_applied' <> 'false'
     or (select next_sequence from public.study_sessions
         where id = '90000000-0000-4000-8000-000000000004') <> 5 then
    raise exception 'sequence tombstone did not advance without projection: %', v_skipped;
  end if;
  select count(*) into v_count
  from public.word_review_events
  where study_observation_id = (v_skipped ->> 'observation_id')::uuid;
  if v_count <> 0 then
    raise exception 'sequence tombstone unexpectedly created a review projection';
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
      where id = '90000000-0000-4000-8000-000000000004') <> 5 then
    raise exception 'session sequence did not advance exactly once per observation';
  end if;

  begin
    perform public.record_study_observation_v1(
      '90000000-0000-4000-8000-000000000001', null,
      'observation_request_gap01',
      '90000000-0000-4000-8000-000000000004', 6,
      '90000000-0000-4000-8000-000000000003', 'shown', 'random', now()
    );
    raise exception 'sequence gap was accepted';
  exception
    when serialization_failure then
      if sqlerrm <> 'STUDY_SEQUENCE_GAP' then raise; end if;
  end;

  begin
    perform public.record_study_observation_v1(
      '90000000-0000-4000-8000-000000000001', null,
      'observation_request_stale1',
      '90000000-0000-4000-8000-000000000004', 2,
      '90000000-0000-4000-8000-000000000003', 'shown', 'random', now()
    );
    raise exception 'already-applied sequence was accepted';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'STUDY_SEQUENCE_ALREADY_APPLIED' then raise; end if;
  end;

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

  v_new_session := public.create_word_study_session_v1(
    '90000000-0000-4000-8000-000000000001', null, 'word', 'random',
    'study', 'guided_random_v1',
    '{"deck_ids":["90000000-0000-4000-8000-000000000002"],"include_mastered":false}'::jsonb,
    1, 'replacement_seed',
    '[{"deck_id":"90000000-0000-4000-8000-000000000002","content_revision":1,"pack_revision":1,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb,
    '[{"item_id":"90000000-0000-4000-8000-000000000003","deck_id":"90000000-0000-4000-8000-000000000002","ordinal":0}]'::jsonb,
    0, '1', false, 'session_request_00000002', repeat('b', 64)
  );
  if v_new_session.status <> 'active'
     or (select status from public.study_sessions
         where id = '90000000-0000-4000-8000-000000000004') <> 'abandoned'
     or (select candidate_count from public.study_sessions
         where id = '90000000-0000-4000-8000-000000000004') <> 1 then
    raise exception 'atomic session replacement did not retire while retaining the old snapshot';
  end if;

  v_replayed_session := public.create_word_study_session_v1(
    '90000000-0000-4000-8000-000000000001', null, 'word', 'random',
    'study', 'guided_random_v1',
    '{"deck_ids":["90000000-0000-4000-8000-000000000002"],"include_mastered":false}'::jsonb,
    1, 'replacement_seed',
    '[{"deck_id":"90000000-0000-4000-8000-000000000002","content_revision":1,"pack_revision":1,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb,
    '[{"item_id":"90000000-0000-4000-8000-000000000003","deck_id":"90000000-0000-4000-8000-000000000002","ordinal":0}]'::jsonb,
    0, '1', false, 'session_request_00000002', repeat('b', 64)
  );
  if v_replayed_session.id <> v_new_session.id then
    raise exception 'session create replay returned a different session';
  end if;

  perform public.prune_word_packs_v1(
    '90000000-0000-4000-8000-000000000002'
  );
  if (select status from public.word_packs where revision = 1
      and deck_id = '90000000-0000-4000-8000-000000000002') <> 'ready'
     or (select status from public.word_packs where revision = 2
         and deck_id = '90000000-0000-4000-8000-000000000002') <> 'stale' then
    raise exception 'pack pruning did not preserve the pinned revision: rev1=%, rev2=%',
      (select status from public.word_packs where revision = 1
       and deck_id = '90000000-0000-4000-8000-000000000002'),
      (select status from public.word_packs where revision = 2
       and deck_id = '90000000-0000-4000-8000-000000000002');
  end if;
end;
$$;

rollback;
