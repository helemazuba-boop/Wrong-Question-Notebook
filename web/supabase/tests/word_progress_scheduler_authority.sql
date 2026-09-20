-- Word progress scheduler authority: switchable SM-2 / FSRS.
--
-- Run inside one rollback-only transaction. Any failed assertion aborts via
-- ON_ERROR_STOP, matching word_study_v1.sql.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/word_progress_scheduler_authority.sql
--
-- The migration this exercises is
-- 20260921000000_word_progress_scheduler_authority.sql. The SM-2 assertions
-- below are the regression baseline: they are the exact ladder values the old
-- record_study_observation_v1 produced, and they must keep holding for any
-- deployment that never flips the authority switch.

begin;

-- pg_temp keeps the helper out of the schema and out of the way of a rollback.
create function pg_temp.expect(p_ok boolean, p_label text, p_detail text default '')
returns void
language plpgsql
as $$
begin
  if not p_ok then
    raise exception 'FAILED: % %', p_label, p_detail;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'word-scheduler@example.invalid');

insert into public.word_decks (id, user_id, title, source, is_system) values
  ('a0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001',
   'Scheduler authority validation', 'user', false);

insert into public.word_entries (id, deck_id, word, normalized_word, meaning, sort_index) values
  ('a0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000002', 'ladder', 'ladder', '阶梯', 0),
  ('a0000000-0000-4000-8000-000000000004',
   'a0000000-0000-4000-8000-000000000002', 'shadow', 'shadow', '影子', 1);

insert into public.study_sessions (
  id, user_id, domain, mode, purpose, ordering, scope, seed, snapshot,
  candidate_items, candidate_count, optional_count,
  create_request_id, create_fingerprint
) values (
  'a0000000-0000-4000-8000-000000000005',
  'a0000000-0000-4000-8000-000000000001',
  'word', 'random', 'study', 'guided_random_v1',
  '{"deck_ids":["a0000000-0000-4000-8000-000000000002"],"include_mastered":false}'::jsonb,
  'authority_seed',
  '[{"deck_id":"a0000000-0000-4000-8000-000000000002","content_revision":1,"pack_revision":1,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb,
  '[{"item_id":"a0000000-0000-4000-8000-000000000003","deck_id":"a0000000-0000-4000-8000-000000000002","ordinal":0},{"item_id":"a0000000-0000-4000-8000-000000000004","deck_id":"a0000000-0000-4000-8000-000000000002","ordinal":1}]'::jsonb,
  2, 2,
  'authority_session_0001',
  repeat('b', 64)
);

-- ---------------------------------------------------------------------------
-- A. SM-2 authority: the ladder is unchanged, and the shadow is queued anyway.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result jsonb;
  v_progress public.word_progress%rowtype;
  v_job public.word_progress_projection_jobs%rowtype;
  v_snapshot jsonb;
  v_link public.word_mistake_links%rowtype;
  v_problem public.problems%rowtype;
  v_step integer := 0;
begin
  -- No user_word_scheduler_settings row exists yet: the sync path must default
  -- to sm2 and behave exactly as it did before the migration.
  perform pg_temp.expect(
    not exists (
      select 1 from public.user_word_scheduler_settings
      where user_id = 'a0000000-0000-4000-8000-000000000001'
    ),
    'A0: no scheduler settings row exists for a fresh user'
  );

  -- A1: unknown -> learning, due immediately, interval 0, lapses + 1.
  v_step := v_step + 1;
  v_result := public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0001',
    'a0000000-0000-4000-8000-000000000005', 0,
    'a0000000-0000-4000-8000-000000000003', 'unknown', 'random',
    '2026-09-01T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_result ->> 'projection_applied' = 'true'
    and v_progress.status = 'learning'
    and v_progress.interval_days = 0
    and v_progress.lapses = 1
    and v_progress.unknown_count = 1
    and v_progress.reviewed_count = 1
    and v_progress.due_at = v_progress.last_reviewed_at
    and v_progress.authority_algorithm = 'sm2',
    'A1: unknown -> learning, due immediately, interval 0, lapses 1',
    format('got status=%s interval=%s lapses=%s', v_progress.status, v_progress.interval_days, v_progress.lapses)
  );

  -- A2: first known -> learning, 1 day, streak 1.
  v_step := v_step + 1;
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0002',
    'a0000000-0000-4000-8000-000000000005', 1,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-09-02T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.status = 'learning'
    and v_progress.interval_days = 1
    and v_progress.correct_streak = 1
    and v_progress.due_at = timestamptz '2026-09-03 00:00:00+00',
    'A2: first known -> learning, 1 day',
    format('got status=%s interval=%s due=%s', v_progress.status, v_progress.interval_days, v_progress.due_at)
  );

  -- A3: second known -> review, 3 days.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0003',
    'a0000000-0000-4000-8000-000000000005', 2,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-09-03T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.status = 'review'
    and v_progress.interval_days = 3
    and v_progress.correct_streak = 2,
    'A3: second known -> review, 3 days',
    format('got status=%s interval=%s', v_progress.status, v_progress.interval_days)
  );

  -- A4: third known -> review, interval doubles to 6.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0004',
    'a0000000-0000-4000-8000-000000000005', 3,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-09-06T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.interval_days = 6
    and v_progress.status = 'review'
    and v_progress.correct_streak = 3,
    'A4: third known -> interval doubles to 6',
    format('got interval=%s', v_progress.interval_days)
  );

  -- A5: every known/unknown observation queues the shadow, in both modes.
  select * into v_job from public.word_progress_projection_jobs
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_job.status = 'pending' and v_job.attempt_count = 0,
    'A5: a pending shadow job exists for the reviewed word',
    format('got status=%s', v_job.status)
  );

  v_snapshot := private.word_progress_timeline_snapshot(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003'
  );
  perform pg_temp.expect(
    (v_snapshot ->> 'event_count')::integer = 4
    -- The snapshot is already the known/unknown subset, so a separate
    -- review count would only ever be a copy of event_count.
    and not (v_snapshot ? 'review_count')
    and v_snapshot ->> 'fingerprint' ~ '^[0-9a-f]{64}$',
    'A6: timeline snapshot counts 4 review events with a sha256 fingerprint',
    v_snapshot::text
  );

  -- A7: a skip observation records a fact but must not queue a projection.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0005',
    'a0000000-0000-4000-8000-000000000005', 4,
    'a0000000-0000-4000-8000-000000000004', 'skipped', 'random',
    '2026-09-07T00:00:00Z'
  );
  perform pg_temp.expect(
    not exists (
      select 1 from public.word_progress_projection_jobs
      where user_id = 'a0000000-0000-4000-8000-000000000001'
        and word_entry_id = 'a0000000-0000-4000-8000-000000000004'
    ),
    'A7: skip records a fact without queueing a projection'
  );

  -- A8: the wrong-word problem is created in the same transaction as the
  -- unknown observation, because word_mistake_links.problem_id is a hard
  -- foreign key. A projector can never backfill it after the fact.
  select link.* into v_link
  from public.word_mistake_links link
  where link.user_id = 'a0000000-0000-4000-8000-000000000001'
    and link.word_entry_id = 'a0000000-0000-4000-8000-000000000003';

  select * into v_problem from public.problems
  where id = v_link.problem_id;

  perform pg_temp.expect(
    v_link.id is not null
    and v_problem.title = 'ladder'
    and v_problem.status = 'wrong'
    and v_problem.content like '%Meaning: 阶梯%'
    and v_problem.last_reviewed_date = timestamptz '2026-09-01 00:00:00+00',
    'A8: unknown creates the wrong-word problem and its link synchronously',
    format('title=%s status=%s', v_problem.title, v_problem.status)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- B. Projector under SM-2 authority: writes the shadow, never the schedule.
-- ---------------------------------------------------------------------------

do $$
declare
  v_claims jsonb;
  v_claim jsonb;
  v_prepared jsonb;
  v_commit jsonb;
  v_before public.word_progress%rowtype;
  v_after public.word_progress%rowtype;
  v_projection public.word_progress_fsrs_projection%rowtype;
  v_card jsonb;
begin
  select * into v_before from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';

  v_claims := public.claim_word_progress_projection_jobs(10, 120);
  select value into v_claim
  from jsonb_array_elements(v_claims)
  where value ->> 'word_entry_id' = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(v_claim is not null, 'B1: the queued job is claimed');

  v_prepared := public.prepare_word_progress_projection(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    (v_claim ->> 'lease_token')::uuid
  );
  perform pg_temp.expect(
    v_prepared ->> 'authority_mode' = 'sm2'
    and jsonb_array_length(v_prepared -> 'events') = 4
    and (v_prepared ->> 'timeline_event_count')::integer = 4
    -- The projector replays the timeline and must never read live state,
    -- so prepare does not ship the current word_progress row at all.
    and not (v_prepared ? 'progress'),
    'B2: prepare reports sm2 authority and the full event list',
    format('events=%s', jsonb_array_length(v_prepared -> 'events'))
  );
  perform pg_temp.expect(
    (v_prepared -> 'events' -> 0 ->> 'outcome') = 'unknown'
    and (v_prepared -> 'events' -> 3 ->> 'outcome') = 'known',
    'B3: events are replayed in chronological order'
  );

  -- A synthetic card: the projector would compute this from the same events.
  v_card := jsonb_build_object(
    'state', 'Review',
    'stability', 12.5,
    'difficulty', 5.1,
    'scheduled_days', 10,
    'learning_step_index', 0,
    'reps', 5,
    'lapses', 1,
    'last_review', '2026-09-07T00:00:00.000Z',
    'due', '2026-09-17T00:00:00.000Z'
  );

  v_commit := public.commit_word_progress_projection(
    (v_prepared ->> 'run_id')::uuid,
    (v_prepared ->> 'lease_token')::uuid,
    (v_prepared ->> 'timeline_event_count')::integer,
    v_prepared ->> 'timeline_fingerprint',
    (v_prepared ->> 'base_projection_revision')::bigint,
    v_card
  );
  perform pg_temp.expect(
    (v_commit ->> 'committed')::boolean
    and (v_commit ->> 'stale')::boolean = false
    and (v_commit ->> 'projection_revision')::bigint = 1
    and v_commit ->> 'authority_mode' = 'sm2',
    'B4: commit succeeds and reports sm2 authority',
    v_commit::text
  );

  select * into v_projection from public.word_progress_fsrs_projection
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_projection.card_initialized
    and v_projection.fsrs_state = 'Review'
    and v_projection.scheduled_days = 10
    and v_projection.projection_revision = 1
    and v_projection.timeline_event_count = 4,
    'B5: the shadow card is stored with its revision and timeline count',
    format('state=%s days=%s', v_projection.fsrs_state, v_projection.scheduled_days)
  );

  select * into v_after from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_after.status = v_before.status
    and v_after.interval_days = v_before.interval_days
    and v_after.due_at = v_before.due_at
    and v_after.authority_algorithm = 'sm2'
    and v_after.authority_projection_revision is null,
    'B6: under sm2 the projector leaves word_progress untouched',
    format('interval %s -> %s', v_before.interval_days, v_after.interval_days)
  );

  perform pg_temp.expect(
    not exists (
      select 1 from public.word_progress_projection_jobs
      where user_id = 'a0000000-0000-4000-8000-000000000001'
        and word_entry_id = 'a0000000-0000-4000-8000-000000000003'
    ),
    'B7: a committed run clears its job'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- C. CAS: a timeline that moved under the run must be refused, not merged.
-- ---------------------------------------------------------------------------

do $$
declare
  v_claim jsonb;
  v_prepared jsonb;
  v_commit jsonb;
  v_job public.word_progress_projection_jobs%rowtype;
begin
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0006',
    'a0000000-0000-4000-8000-000000000005', 5,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-09-12T00:00:00Z'
  );

  select value into v_claim
  from jsonb_array_elements(public.claim_word_progress_projection_jobs(10, 120))
  where value ->> 'word_entry_id' = 'a0000000-0000-4000-8000-000000000003';

  v_prepared := public.prepare_word_progress_projection(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    (v_claim ->> 'lease_token')::uuid
  );

  -- A scheduling fact lands out of band while the run is in flight: a repair
  -- script, a backfill, or any future correction path that writes the fact
  -- table without going through record_study_observation_v1. The job lease is
  -- untouched, so only the fingerprint can catch this.
  insert into public.word_review_events (
    id, user_id, word_entry_id, outcome, mode, source, created_at
  ) values (
    'a0000000-0000-4000-8000-00000000000a',
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    'known', 'random', 'system',
    '2026-09-13T00:00:00Z'
  );

  v_commit := public.commit_word_progress_projection(
    (v_prepared ->> 'run_id')::uuid,
    (v_prepared ->> 'lease_token')::uuid,
    (v_prepared ->> 'timeline_event_count')::integer,
    v_prepared ->> 'timeline_fingerprint',
    (v_prepared ->> 'base_projection_revision')::bigint,
    jsonb_build_object(
      'state', 'Review', 'stability', 1.0, 'difficulty', 5.0,
      'scheduled_days', 1, 'learning_step_index', 0, 'reps', 1, 'lapses', 0,
      'last_review', '2026-09-12T00:00:00.000Z', 'due', '2026-09-13T00:00:00.000Z'
    )
  );
  perform pg_temp.expect(
    (v_commit ->> 'committed')::boolean = false
    and (v_commit ->> 'stale')::boolean,
    'C1: a commit whose fingerprint moved under it is refused as stale',
    v_commit::text
  );

  select * into v_job from public.word_progress_projection_jobs
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_job.status = 'pending' and v_job.lease_token is null,
    'C2: the refused run returns the job to the queue with its lease released',
    format('status=%s', v_job.status)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- D. FSRS authority: the sync path keeps the counters, the projector schedules.
-- ---------------------------------------------------------------------------

do $$
declare
  v_claim jsonb;
  v_prepared jsonb;
  v_commit jsonb;
  v_progress public.word_progress%rowtype;
  v_after_commit public.word_progress%rowtype;
  v_due_before timestamptz;
  v_interval_before integer;
  v_problem_status text;
  v_problem_reviewed timestamptz;
begin
  -- Cut the user over explicitly. The projector has caught up, so the guard
  -- conditions hold.
  insert into public.user_word_scheduler_settings (user_id, authority_mode)
  values ('a0000000-0000-4000-8000-000000000001', 'fsrs');

  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  v_due_before := v_progress.due_at;
  v_interval_before := v_progress.interval_days;

  -- D1: the sync path no longer writes the schedule.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0008',
    'a0000000-0000-4000-8000-000000000005', 6,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-09-20T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.due_at = v_due_before
    and v_progress.interval_days = v_interval_before
    and v_progress.correct_streak = 4
    and v_progress.reviewed_count = 6
    and v_progress.known_count = 5,
    'D1: under fsrs the sync path keeps counters and leaves the schedule alone',
    format('due %s -> %s, interval %s -> %s', v_due_before, v_progress.due_at, v_interval_before, v_progress.interval_days)
  );
  perform pg_temp.expect(
    v_progress.correct_streak = 4 and v_progress.last_reviewed_at = timestamptz '2026-09-20 00:00:00+00',
    'D2: last_reviewed_at advances so stale observations stay ignored'
  );

  -- D3: the projector now owns status, due_at, interval_days and lapses.
  select value into v_claim
  from jsonb_array_elements(public.claim_word_progress_projection_jobs(10, 120))
  where value ->> 'word_entry_id' = 'a0000000-0000-4000-8000-000000000003';
  v_prepared := public.prepare_word_progress_projection(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    (v_claim ->> 'lease_token')::uuid
  );
  perform pg_temp.expect(
    v_prepared ->> 'authority_mode' = 'fsrs',
    'D3: prepare reports fsrs authority'
  );

  v_commit := public.commit_word_progress_projection(
    (v_prepared ->> 'run_id')::uuid,
    (v_prepared ->> 'lease_token')::uuid,
    (v_prepared ->> 'timeline_event_count')::integer,
    v_prepared ->> 'timeline_fingerprint',
    (v_prepared ->> 'base_projection_revision')::bigint,
    jsonb_build_object(
      'state', 'Review', 'stability', 30.0, 'difficulty', 6.0,
      'scheduled_days', 45, 'learning_step_index', 0, 'reps', 6, 'lapses', 1,
      'last_review', '2026-09-20T00:00:00.000Z', 'due', '2026-11-04T00:00:00.000Z'
    )
  );
  perform pg_temp.expect((v_commit ->> 'committed')::boolean, 'D4: fsrs commit succeeds');

  select * into v_after_commit from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_after_commit.status = 'mastered'
    and v_after_commit.due_at = timestamptz '2026-11-04 00:00:00+00'
    and v_after_commit.interval_days = 45
    and v_after_commit.lapses = 1
    and v_after_commit.authority_algorithm = 'fsrs'
    and v_after_commit.authority_projection_revision = 2,
    'D5: the fsrs commit writes status/due/interval/lapses and the authority marker',
    format('status=%s due=%s interval=%s rev=%s', v_after_commit.status, v_after_commit.due_at, v_after_commit.interval_days, v_after_commit.authority_projection_revision)
  );

  -- D6: 45 days is >= the 30 day promotion threshold, so the mastered status
  -- also archives the wrong-word problem section A created, without deleting
  -- the link or the problem row.
  select problem.status, problem.last_reviewed_date
    into v_problem_status, v_problem_reviewed
  from public.problems problem
  join public.word_mistake_links link on link.problem_id = problem.id
  where link.user_id = 'a0000000-0000-4000-8000-000000000001'
    and link.word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_problem_status = 'mastered'
    and v_problem_reviewed = timestamptz '2026-09-20 00:00:00+00',
    'D6: the mastered commit archives the linked wrong-word problem',
    format('status=%s last_reviewed=%s', v_problem_status, v_problem_reviewed)
  );

  -- D7: unknown under fsrs does not schedule immediately in the sync path.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0009',
    'a0000000-0000-4000-8000-000000000005', 7,
    'a0000000-0000-4000-8000-000000000003', 'unknown', 'random',
    '2026-11-05T00:00:00Z'
  );
  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.due_at = timestamptz '2026-11-04 00:00:00+00'
    and v_progress.interval_days = 45
    and v_progress.unknown_count = 2
    and v_progress.lapses = 1,
    'D7: unknown under fsrs defers the schedule to the projector',
    format('due=%s interval=%s', v_progress.due_at, v_progress.interval_days)
  );

  -- D8: and the projector turns that Again into an immediate re-review.
  select value into v_claim
  from jsonb_array_elements(public.claim_word_progress_projection_jobs(10, 120))
  where value ->> 'word_entry_id' = 'a0000000-0000-4000-8000-000000000003';
  v_prepared := public.prepare_word_progress_projection(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    (v_claim ->> 'lease_token')::uuid
  );
  v_commit := public.commit_word_progress_projection(
    (v_prepared ->> 'run_id')::uuid,
    (v_prepared ->> 'lease_token')::uuid,
    (v_prepared ->> 'timeline_event_count')::integer,
    v_prepared ->> 'timeline_fingerprint',
    (v_prepared ->> 'base_projection_revision')::bigint,
    jsonb_build_object(
      'state', 'Relearning', 'stability', 2.0, 'difficulty', 7.0,
      'scheduled_days', 0, 'learning_step_index', 0, 'reps', 7, 'lapses', 2,
      'last_review', '2026-11-05T00:00:00.000Z', 'due', '2026-11-05T00:00:00.000Z'
    )
  );
  select * into v_after_commit from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_after_commit.status = 'learning'
    and v_after_commit.interval_days = 0
    and v_after_commit.lapses = 2
    and v_after_commit.due_at = timestamptz '2026-11-05 00:00:00+00',
    'D8: Again under fsrs lands as an immediate relearning due date',
    format('status=%s due=%s interval=%s', v_after_commit.status, v_after_commit.due_at, v_after_commit.interval_days)
  );

  -- D9: the wrong-word projection stays synchronous under fsrs authority too:
  -- an unknown reopens the archived problem instead of leaving it mastered.
  --
  -- The observation is dated 2026-11-05, but record_study_observation_v1 clamps
  -- occurred_at with least(now(), ...) so a device clock in the future cannot
  -- move the schedule forward. Both the problem row and word_progress get the
  -- same clamped instant, so compare them against each other instead of against
  -- the literal date.
  select problem.status, problem.last_reviewed_date
    into v_problem_status, v_problem_reviewed
  from public.problems problem
  join public.word_mistake_links link on link.problem_id = problem.id
  where link.user_id = 'a0000000-0000-4000-8000-000000000001'
    and link.word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_problem_status = 'wrong'
    and v_problem_reviewed = (
      select progress.last_reviewed_at
      from public.word_progress progress
      where progress.user_id = 'a0000000-0000-4000-8000-000000000001'
        and progress.word_entry_id = 'a0000000-0000-4000-8000-000000000003'
    )
    and v_problem_reviewed > timestamptz '2026-09-20 00:00:00+00',
    'D9: unknown under fsrs reopens the wrong-word problem synchronously',
    format('status=%s last_reviewed=%s', v_problem_status, v_problem_reviewed)
  );

  -- D10: the one year cap lives in the RPC as well, so a repair script or a
  -- backfill that hands over a longer card cannot outlive the product rule.
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0011',
    'a0000000-0000-4000-8000-000000000005', 8,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-11-07T00:00:00Z'
  );
  select value into v_claim
  from jsonb_array_elements(public.claim_word_progress_projection_jobs(10, 120))
  where value ->> 'word_entry_id' = 'a0000000-0000-4000-8000-000000000003';
  v_prepared := public.prepare_word_progress_projection(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    (v_claim ->> 'lease_token')::uuid
  );
  v_commit := public.commit_word_progress_projection(
    (v_prepared ->> 'run_id')::uuid,
    (v_prepared ->> 'lease_token')::uuid,
    (v_prepared ->> 'timeline_event_count')::integer,
    v_prepared ->> 'timeline_fingerprint',
    (v_prepared ->> 'base_projection_revision')::bigint,
    jsonb_build_object(
      'state', 'Review', 'stability', 900.0, 'difficulty', 5.5,
      'scheduled_days', 400, 'learning_step_index', 0, 'reps', 8, 'lapses', 2,
      'last_review', '2026-11-07T00:00:00.000Z', 'due', '2027-12-12T00:00:00.000Z'
    )
  );
  select * into v_after_commit from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    (v_commit ->> 'committed')::boolean
    and v_after_commit.interval_days = 365
    and v_after_commit.status = 'mastered'
    and v_after_commit.due_at = timestamptz '2027-12-12 00:00:00+00',
    'D10: the RPC caps interval_days at one year even for a longer card',
    format('interval=%s due=%s', v_after_commit.interval_days, v_after_commit.due_at)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- E. Cutover guards and rollback.
-- ---------------------------------------------------------------------------

do $$
declare
  v_cutover jsonb;
  v_progress public.word_progress%rowtype;
  v_settings public.user_word_scheduler_settings%rowtype;
  v_snapshot public.word_progress_fsrs_projection%rowtype;
  v_expected jsonb;
  v_cancel jsonb;
begin
  -- The user is already on fsrs from section D; put them back on sm2 with the
  -- explicit cutover path so the guards can be exercised from a clean state.
  update public.user_word_scheduler_settings
  set authority_mode = 'sm2', active_cutover_id = null
  where user_id = 'a0000000-0000-4000-8000-000000000001';
  update public.word_progress
  set authority_algorithm = 'sm2', authority_projection_revision = null
  where user_id = 'a0000000-0000-4000-8000-000000000001';

  select * into v_snapshot from public.word_progress_fsrs_projection
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  v_expected := jsonb_build_array(jsonb_build_object(
    'word_entry_id', v_snapshot.word_entry_id,
    'projection_revision', v_snapshot.projection_revision,
    'timeline_fingerprint', v_snapshot.timeline_fingerprint
  ));

  -- E1: a reviewed word without a shadow blocks the cutover. Word 0004 was only
  -- ever skipped, so it has no card; the guard reads the fact table rather than
  -- the progress row, so a single scheduling fact for it trips the guard.
  insert into public.word_review_events (
    id, user_id, word_entry_id, outcome, mode, source, created_at
  ) values (
    'a0000000-0000-4000-8000-00000000000b',
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000004',
    'known', 'random', 'system',
    '2026-09-08T00:00:00Z'
  );
  begin
    perform public.cutover_user_word_progress_to_fsrs(
      'a0000000-0000-4000-8000-000000000001',
      v_expected
    );
    perform pg_temp.expect(false, 'E1: cutover should refuse while a shadow is missing');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%FSRS_CUTOVER_PROJECTION_MISSING%',
      'E1: cutover refuses while a reviewed word has no shadow card',
      sqlerrm
    );
  end;
  delete from public.word_review_events
  where id = 'a0000000-0000-4000-8000-00000000000b';

  -- E2: a queued projection job blocks the cutover.
  perform private.mark_word_progress_timeline_dirty(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000004',
    timestamptz '2026-09-08 00:00:00+00'
  );
  begin
    perform public.cutover_user_word_progress_to_fsrs(
      'a0000000-0000-4000-8000-000000000001',
      v_expected
    );
    perform pg_temp.expect(false, 'E2: cutover should refuse while a job is dirty');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%FSRS_CUTOVER_PROJECTION_DIRTY%',
      'E2: cutover refuses while the projection queue is not empty',
      sqlerrm
    );
  end;

  -- Clear the queue so the remaining guards are reachable.
  delete from public.word_progress_projection_jobs
  where user_id = 'a0000000-0000-4000-8000-000000000001';

  -- E3: the expectation list must name every initialized shadow.
  begin
    perform public.cutover_user_word_progress_to_fsrs(
      'a0000000-0000-4000-8000-000000000001',
      '[]'::jsonb
    );
    perform pg_temp.expect(false, 'E3: cutover should refuse a short expectation list');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%FSRS_CUTOVER_EXPECTATION_MISMATCH%',
      'E3: cutover refuses an expectation list that misses a shadow',
      sqlerrm
    );
  end;

  -- E4: an expectation that names the wrong revision is refused as stale.
  begin
    perform public.cutover_user_word_progress_to_fsrs(
      'a0000000-0000-4000-8000-000000000001',
      jsonb_build_array(jsonb_build_object(
        'word_entry_id', v_snapshot.word_entry_id,
        'projection_revision', 999,
        'timeline_fingerprint', v_snapshot.timeline_fingerprint
      ))
    );
    perform pg_temp.expect(false, 'E4: cutover should refuse a stale expectation');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%FSRS_CUTOVER_PROJECTION_STALE%',
      'E4: cutover refuses an expectation that does not match the stored revision',
      sqlerrm
    );
  end;

  -- E5: the happy path promotes the shadow and records a rollback snapshot.
  v_cutover := public.cutover_user_word_progress_to_fsrs(
    'a0000000-0000-4000-8000-000000000001',
    v_expected
  );
  perform pg_temp.expect(
    v_cutover ->> 'authority_mode' = 'fsrs'
    and (v_cutover ->> 'word_count')::integer >= 1,
    'E5: cutover promotes the user and reports the promoted word count',
    v_cutover::text
  );

  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.authority_algorithm = 'fsrs'
    and v_progress.authority_projection_revision = v_snapshot.projection_revision
    and v_progress.due_at = v_snapshot.next_review_at,
    'E6: the promoted row carries the shadow revision and due date',
    format('rev=%s due=%s', v_progress.authority_projection_revision, v_progress.due_at)
  );

  select * into v_settings from public.user_word_scheduler_settings
  where user_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.expect(
    v_settings.authority_mode = 'fsrs' and v_settings.active_cutover_id is not null,
    'E7: the settings row points at the active cutover'
  );

  -- E8: with the timeline unchanged since the snapshot was taken, the rollback
  -- restores the pre-cutover values and returns the user to sm2.
  v_cancel := public.cancel_word_progress_fsrs_cutover(
    'a0000000-0000-4000-8000-000000000001',
    (v_cutover ->> 'cutover_id')::uuid
  );
  perform pg_temp.expect(
    v_cancel ->> 'authority_mode' = 'sm2'
    -- A snapshot taken for a word with no word_progress row has nothing
    -- to restore and must not be counted, or the operator is told about a
    -- rollback that never happened.
    and (v_cancel ->> 'restored_word_count')::integer = (
      select count(*)
      from public.word_progress_authority_cutover_snapshots snapshot
      where snapshot.cutover_id = (v_cutover ->> 'cutover_id')::uuid
        and snapshot.progress_existed
    ),
    'E8: cancel restores the user to sm2 and counts only restorable words',
    v_cancel::text
  );

  select * into v_progress from public.word_progress
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_progress.authority_algorithm = 'sm2'
    and v_progress.authority_projection_revision is null,
    'E9: the restored row drops the fsrs authority marker',
    format('algorithm=%s rev=%s', v_progress.authority_algorithm, v_progress.authority_projection_revision)
  );

  -- E10: a fresh cutover followed by a new review makes the rollback unsafe.
  -- The shadow itself is unchanged, so the same expectation still matches.
  v_cutover := public.cutover_user_word_progress_to_fsrs(
    'a0000000-0000-4000-8000-000000000001',
    v_expected
  );
  perform public.record_study_observation_v1(
    'a0000000-0000-4000-8000-000000000001', null,
    'authority_request_0010',
    'a0000000-0000-4000-8000-000000000005', 9,
    'a0000000-0000-4000-8000-000000000003', 'known', 'random',
    '2026-11-06T00:00:00Z'
  );
  begin
    perform public.cancel_word_progress_fsrs_cutover(
      'a0000000-0000-4000-8000-000000000001',
      (v_cutover ->> 'cutover_id')::uuid
    );
    perform pg_temp.expect(false, 'E10: cancel should refuse once new reviews arrived');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%FSRS_CUTOVER_HAS_NEW_REVIEWS%',
      'E10: cancel refuses once the timeline moved past the cutover snapshot',
      sqlerrm
    );
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- F. Environment default seeding.
-- ---------------------------------------------------------------------------

do $$
declare
  v_seed jsonb;
  v_mode text;
begin
  delete from public.user_word_scheduler_settings
  where user_id = 'a0000000-0000-4000-8000-000000000001';

  v_seed := public.seed_word_scheduler_settings('sm2');
  perform pg_temp.expect(
    (v_seed ->> 'inserted')::integer >= 1,
    'F1: seeding with sm2 creates the missing settings row',
    v_seed::text
  );

  select authority_mode into v_mode from public.user_word_scheduler_settings
  where user_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.expect(v_mode = 'sm2', 'F2: the seeded row carries the requested mode');

  -- A second run is a no-op: existing rows are never rewritten.
  v_seed := public.seed_word_scheduler_settings('fsrs');
  perform pg_temp.expect(
    (v_seed ->> 'inserted')::integer = 0,
    'F3: seeding never rewrites a user that already has a row',
    v_seed::text
  );

  delete from public.user_word_scheduler_settings
  where user_id = 'a0000000-0000-4000-8000-000000000001';
  -- word_entry 0004 has no shadow card (it was only skipped, never reviewed),
  -- but 0003 was reviewed and is projected, so this must still refuse while
  -- 0004 has no card only if 0004 was reviewed. It was not, so the seed
  -- succeeds; assert the fsrs default is applied instead.
  v_seed := public.seed_word_scheduler_settings('fsrs');
  select authority_mode into v_mode from public.user_word_scheduler_settings
  where user_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.expect(
    v_mode = 'fsrs',
    'F4: seeding with fsrs applies once every reviewed word is projected',
    format('inserted=%s mode=%s', v_seed ->> 'inserted', v_mode)
  );

  begin
    perform public.seed_word_scheduler_settings('bogus');
    perform pg_temp.expect(false, 'F5: an unknown default should be rejected');
  exception when others then
    perform pg_temp.expect(
      sqlerrm like '%INVALID_WORD_SCHEDULER_DEFAULT%',
      'F5: an unknown default mode is rejected',
      sqlerrm
    );
  end;
end;
$$;

-- G: a job that keeps failing must stop being claimable rather than retrying
--    once an hour forever, and a new fact must give it its budget back.
do $$
declare
  v_claims jsonb;
  v_claim jsonb;
  v_job public.word_progress_projection_jobs%rowtype;
  v_attempt integer;
begin
  -- Nothing from the earlier sections should still be queued.
  delete from public.word_progress_projection_jobs;

  perform private.mark_word_progress_timeline_dirty(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    now()
  );

  for v_attempt in 1..8 loop
    -- Rewind the retry clock so the loop does not have to sit through the real
    -- exponential backoff.
    update public.word_progress_projection_jobs
    set next_retry_at = now() - interval '1 second'
    where user_id = 'a0000000-0000-4000-8000-000000000001'
      and word_entry_id = 'a0000000-0000-4000-8000-000000000003';

    v_claims := public.claim_word_progress_projection_jobs(1, 30);
    v_claim := v_claims -> 0;
    perform pg_temp.expect(
      v_claim is not null,
      format('G: the job is claimable on attempt %s', v_attempt)
    );

    perform public.fail_word_progress_projection_job(
      (v_claim ->> 'user_id')::uuid,
      (v_claim ->> 'word_entry_id')::uuid,
      (v_claim ->> 'lease_token')::uuid,
      'FSRS_CALCULATION_FAILED'
    );
  end loop;

  select * into v_job from public.word_progress_projection_jobs
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_job.attempt_count = 8
    and v_job.next_retry_at = 'infinity'::timestamptz
    and v_job.last_error_code = 'FSRS_CALCULATION_FAILED',
    'G1: the job stops being claimable after its last attempt',
    format('attempts=%s next=%s', v_job.attempt_count, v_job.next_retry_at)
  );

  perform pg_temp.expect(
    jsonb_array_length(public.claim_word_progress_projection_jobs(10, 30)) = 0,
    'G2: an exhausted job is never claimed again'
  );

  -- Under fsrs authority a frozen job freezes the word's due date, so the only
  -- thing that may clear it is a new fact (or an operator requeueing it).
  perform private.mark_word_progress_timeline_dirty(
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    now()
  );
  select * into v_job from public.word_progress_projection_jobs
  where user_id = 'a0000000-0000-4000-8000-000000000001'
    and word_entry_id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.expect(
    v_job.attempt_count = 0
    and v_job.status = 'pending'
    and v_job.next_retry_at <= now(),
    'G3: a new fact gives the word its attempt budget back',
    format('attempts=%s status=%s', v_job.attempt_count, v_job.status)
  );
end;
$$;

select 'word_progress_scheduler_authority: all assertions passed' as result;

rollback;
