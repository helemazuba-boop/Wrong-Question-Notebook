begin;

create extension if not exists pgtap with schema extensions;

select plan(55);

insert into auth.users (id, email)
values
  ('11000000-0000-4000-8000-000000000001', 'fsrs-owner@example.com'),
  ('11000000-0000-4000-8000-000000000002', 'fsrs-other@example.com');

update public.user_profiles
set timezone = 'UTC'
where id = '11000000-0000-4000-8000-000000000001';

insert into public.subjects (id, user_id, name)
values (
  '22000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  'FSRS fixture'
);

insert into public.problems (
  id,
  user_id,
  subject_id,
  title,
  status,
  parts,
  source,
  assets,
  solution_assets,
  is_optional
) values
  (
    '33000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    'FSRS primary fixture',
    'needs_review',
    '[{"index":1,"type":"short_answer","content":"Q1"}]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    false
  ),
  (
    '33000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    'FSRS cutover fixture',
    'needs_review',
    '[{"index":1,"type":"short_answer","content":"Q2"}]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    false
  );

set local role service_role;

select ok(
  to_regclass('public.fsrs_parameter_sets') is not null,
  'fsrs_parameter_sets exists'
);
select ok(
  to_regclass('public.user_fsrs_settings') is not null,
  'user_fsrs_settings exists'
);
select ok(
  to_regclass('public.problem_review_occurrence_parameter_assignments') is not null,
  'occurrence assignments table exists'
);
select ok(
  to_regclass('public.problem_review_sm2_compatibility_baselines') is not null,
  'SM-2 compatibility baselines table exists'
);
select ok(
  to_regclass('public.problem_review_projection_runs') is not null,
  'projection runs table exists'
);
select ok(
  to_regclass('public.problem_review_schedule_applications') is not null,
  'schedule Applications table exists'
);
select ok(
  to_regclass('public.fsrs_review_schedule_projection') is not null,
  'FSRS shadow projection table exists'
);
select ok(
  to_regclass('public.fsrs_authority_cutovers') is not null,
  'FSRS cutovers table exists'
);
select ok(
  to_regclass('public.fsrs_authority_cutover_snapshots') is not null,
  'FSRS cutover snapshots table exists'
);

select is(
  (select stable_key from public.fsrs_parameter_sets where stable_key = 'default-v1'),
  'default-v1',
  'default FSRS parameter set has a stable identity'
);
select is(
  (
    select jsonb_array_length(parameters -> 'w')
    from public.fsrs_parameter_sets
    where stable_key = 'default-v1'
  ),
  21,
  'default FSRS parameter set freezes 21 weights'
);
select is(
  (
    select algorithm_version || '/' || library_name || '@' || library_version
    from public.fsrs_parameter_sets
    where stable_key = 'default-v1'
  ),
  'FSRS-6.0/ts-fsrs@5.4.1',
  'default parameter provenance is exact'
);

select ok(
  not has_table_privilege('authenticated', 'public.fsrs_parameter_sets', 'SELECT'),
  'browser cannot read raw parameter JSON'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.problem_review_schedule_applications',
    'SELECT'
  ),
  'browser cannot read raw FSRS Applications'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.problem_review_projection_runs',
    'SELECT'
  ),
  'browser cannot read raw projector runs'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.problem_review_occurrence_parameter_assignments',
    'SELECT'
  ),
  'browser cannot read occurrence assignments'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.problem_review_sm2_compatibility_baselines',
    'SELECT'
  ),
  'browser cannot read SM-2 compatibility baselines'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.fsrs_authority_cutover_snapshots',
    'SELECT'
  ),
  'browser cannot read cutover snapshots'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_problem_review_scheduler_diagnostics(uuid)',
    'EXECUTE'
  ),
  'owner-safe diagnostics RPC is authenticated'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_problem_review_projection_jobs(integer,integer)',
    'EXECUTE'
  ),
  'browser cannot claim projector jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.commit_problem_review_projection(uuid,uuid,integer,text,bigint,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'browser cannot commit scheduler projections'
);

reset role;

insert into public.review_schedule (
  user_id,
  problem_id,
  next_review_at,
  interval_days,
  ease_factor,
  repetition_number,
  last_reviewed_at
) values (
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  '2026-08-07 00:00:00+00',
  12,
  2.4,
  3,
  '2026-08-08 00:00:00+00'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '44000000-0000-4000-8000-000000000001',
      '55000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Hard',
      false,
      'web',
      null,
      'fsrs-review-000001',
      '2026-08-08 08:00:00+00',
      null,
      null
    )
  $$,
  'human Review fact atomically establishes scheduler provenance'
);

select is(
  (
    select stable_key
    from public.problem_review_occurrence_parameter_assignments assignment
    join public.fsrs_parameter_sets parameters
      on parameters.id = assignment.parameter_set_id
    where assignment.review_occurrence_id =
      '55000000-0000-4000-8000-000000000001'
  ),
  'default-v1',
  'new Review freezes the active parameter set at fact time'
);
select is(
  (
    select next_review_at
    from public.problem_review_sm2_compatibility_baselines
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  '2026-08-07 00:00:00+00'::timestamptz,
  'first compatibility Review snapshots legacy SM-2 due'
);
select is(
  (
    select status
    from public.problem_review_projection_jobs
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  'pending',
  'Review fact leaves a durable dirty job'
);

-- Simulate scheduler provenance missing after the immutable Event committed. An
-- idempotent source request must reconstruct all three scheduler prerequisites.
delete from public.problem_review_occurrence_parameter_assignments
where review_occurrence_id = '55000000-0000-4000-8000-000000000001';
delete from public.problem_review_sm2_compatibility_baselines
where user_id = '11000000-0000-4000-8000-000000000001'
  and problem_id = '33000000-0000-4000-8000-000000000001';
delete from public.problem_review_projection_jobs
where user_id = '11000000-0000-4000-8000-000000000001'
  and problem_id = '33000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '44000000-0000-4000-8000-000000000001',
      '55000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Hard',
      false,
      'web',
      null,
      'fsrs-review-000001',
      '2026-08-08 08:00:00+00',
      null,
      null
    )
  $$,
  'Review request replay repairs scheduler state'
);
select is(
  (
    select status
    from public.problem_review_projection_jobs
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  'pending',
  'request replay recreates the durable projection job'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_occurrence_parameter_assignments
    where review_occurrence_id = '55000000-0000-4000-8000-000000000001'
  ),
  1,
  'request replay never duplicates parameter assignment'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_sm2_compatibility_baselines
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  1,
  'request replay never replaces compatibility baseline'
);

select throws_ok(
  $$
    update public.problem_review_occurrence_parameter_assignments
    set parameter_set_id = 'f5000000-0000-4000-8000-000000000001'
    where review_occurrence_id = '55000000-0000-4000-8000-000000000001'
  $$,
  '55000',
  'FSRS_SCHEDULER_FACTS_APPEND_ONLY',
  'occurrence parameter assignment is append-only'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '44000000-0000-4000-8000-000000000002',
      '55000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Good',
      false,
      'web',
      null,
      'fsrs-correct-00001',
      '2026-08-08 08:00:00+00',
      null,
      '44000000-0000-4000-8000-000000000001'
    )
  $$,
  'Rating correction reuses the same occurrence provenance'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_occurrence_parameter_assignments
    where review_occurrence_id = '55000000-0000-4000-8000-000000000001'
  ),
  1,
  'Rating correction does not create another assignment'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '44000000-0000-4000-8000-000000000003',
      '55000000-0000-4000-8000-000000000002',
      '11000000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000002',
      null,
      'skip',
      null,
      null,
      'web',
      null,
      'fsrs-skip-0000001',
      '2026-08-08 09:00:00+00',
      null,
      null
    )
  $$,
  'skip remains a durable occurrence fact'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_occurrence_parameter_assignments
    where review_occurrence_id = '55000000-0000-4000-8000-000000000002'
  ),
  0,
  'skip gets no FSRS parameter assignment'
);

create temporary table claimed_jobs as
select value as job
from jsonb_array_elements(public.claim_problem_review_projection_jobs(10, 120));

select is(
  (
    select status
    from public.problem_review_projection_jobs projection_job
    where projection_job.user_id = '11000000-0000-4000-8000-000000000001'
      and projection_job.problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  'processing',
  'claim moves dirty job to processing'
);
select is(
  (
    select (job ->> 'attempt_count')::integer
    from claimed_jobs
    where job ->> 'problem_id' = '33000000-0000-4000-8000-000000000001'
  ),
  1,
  'claim increments attempt count'
);
select is(
  jsonb_array_length(public.claim_problem_review_projection_jobs(10, 120)),
  0,
  'active leases are not double-claimed'
);

create temporary table prepared_projection as
select public.prepare_problem_review_projection(
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  (
    select (job ->> 'lease_token')::uuid
    from claimed_jobs
    where job ->> 'problem_id' = '33000000-0000-4000-8000-000000000001'
  )
) as payload;

select is(
  jsonb_array_length((select payload -> 'events' from prepared_projection)),
  1,
  'prepare returns only the effective terminal occurrence Event'
);
select is(
  (select payload #>> '{events,0,human_rating}' from prepared_projection),
  'Good',
  'prepare sees corrected human-final Rating'
);
select is(
  (select payload #>> '{events,0,parameter_stable_key}' from prepared_projection),
  'default-v1',
  'prepare returns the frozen parameter set, not worker-time active state'
);

select is(
  public.fail_problem_review_projection_job(
    '11000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001',
    (
      select (job ->> 'lease_token')::uuid
      from claimed_jobs
      where job ->> 'problem_id' = '33000000-0000-4000-8000-000000000001'
    ),
    'FSRS_CALCULATION_FAILED'
  ),
  true,
  'failed projection releases its lease into finite retry state'
);
select is(
  (
    select status || '/' || last_error_code
    from public.problem_review_projection_jobs
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000001'
  ),
  'retry/FSRS_CALCULATION_FAILED',
  'failure records a finite error code'
);

-- Skip-only jobs can be committed as an empty FSRS projection.
update public.problem_review_projection_jobs
set status = 'pending',
    lease_token = null,
    lease_until = null,
    next_retry_at = clock_timestamp()
where user_id = '11000000-0000-4000-8000-000000000001';

truncate claimed_jobs;
insert into claimed_jobs
select value
from jsonb_array_elements(public.claim_problem_review_projection_jobs(10, 120));

create temporary table prepared_skip as
select public.prepare_problem_review_projection(
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000002',
  (
    select (job ->> 'lease_token')::uuid
    from claimed_jobs
    where job ->> 'problem_id' = '33000000-0000-4000-8000-000000000002'
  )
) as payload;

select is(
  (
    select public.commit_problem_review_projection(
      (payload ->> 'run_id')::uuid,
      (payload ->> 'lease_token')::uuid,
      (payload ->> 'timeline_event_count')::integer,
      payload ->> 'timeline_fingerprint',
      (payload ->> 'base_projection_revision')::bigint,
      '[]'::jsonb,
      null,
      null
    ) ->> 'committed'
    from prepared_skip
  ),
  'true',
  'skip-only timeline commits an empty shadow projection'
);
select is(
  (
    select card_initialized
    from public.fsrs_review_schedule_projection
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000002'
  ),
  false,
  'skip-only shadow Card remains uninitialized'
);

-- Direct fixtures model a caught-up Card to exercise safe cutover semantics.
insert into public.problem_review_occurrences (
  id, user_id, problem_id, reviewed_at, effective_review_at
) values (
  '55000000-0000-4000-8000-000000000003',
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000002',
  '2026-08-08 10:00:00+00',
  '2026-08-08 10:00:00+00'
);
insert into public.problem_review_events (
  id,
  review_occurrence_id,
  user_id,
  problem_id,
  event_kind,
  human_rating,
  channel_source,
  source_request_id,
  reviewed_at,
  received_at,
  effective_review_at
) values (
  '44000000-0000-4000-8000-000000000004',
  '55000000-0000-4000-8000-000000000003',
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000002',
  'review',
  'Good',
  'migration',
  'fsrs-migration-0001',
  '2026-08-08 10:00:00+00',
  '2026-08-08 10:00:00+00',
  '2026-08-08 10:00:00+00'
);

-- The trigger has frozen provenance and dirtied the timeline. Store trusted
-- projection fixtures with exact database-side timeline fingerprints.
delete from public.problem_review_projection_jobs
where user_id = '11000000-0000-4000-8000-000000000001';

insert into public.fsrs_review_schedule_projection (
  user_id,
  problem_id,
  card_initialized,
  calculated_parameter_set_id,
  fsrs_state,
  stability,
  difficulty,
  scheduled_days,
  learning_step_index,
  reps,
  lapses,
  last_reviewed_at,
  next_review_at,
  projection_revision,
  timeline_event_count,
  timeline_fingerprint,
  last_event_id
)
select
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  true,
  'f5000000-0000-4000-8000-000000000001',
  'Review',
  2.3065,
  5.1,
  3,
  0,
  1,
  0,
  '2026-08-08 08:00:00+00',
  '2026-08-11 08:00:00+00',
  1,
  (private.problem_review_timeline_snapshot(
    '11000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001'
  ) ->> 'event_count')::integer,
  private.problem_review_timeline_snapshot(
    '11000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001'
  ) ->> 'fingerprint',
  '44000000-0000-4000-8000-000000000002'
on conflict (user_id, problem_id) do update
set card_initialized = excluded.card_initialized,
    calculated_parameter_set_id = excluded.calculated_parameter_set_id,
    fsrs_state = excluded.fsrs_state,
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    scheduled_days = excluded.scheduled_days,
    learning_step_index = excluded.learning_step_index,
    reps = excluded.reps,
    lapses = excluded.lapses,
    last_reviewed_at = excluded.last_reviewed_at,
    next_review_at = excluded.next_review_at,
    projection_revision = excluded.projection_revision,
    timeline_event_count = excluded.timeline_event_count,
    timeline_fingerprint = excluded.timeline_fingerprint,
    last_event_id = excluded.last_event_id;

insert into public.fsrs_review_schedule_projection (
  user_id,
  problem_id,
  card_initialized,
  calculated_parameter_set_id,
  fsrs_state,
  stability,
  difficulty,
  scheduled_days,
  learning_step_index,
  reps,
  lapses,
  last_reviewed_at,
  next_review_at,
  projection_revision,
  timeline_event_count,
  timeline_fingerprint,
  last_event_id
)
select
  '11000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000002',
  true,
  'f5000000-0000-4000-8000-000000000001',
  'Review',
  2.3065,
  5.1,
  3,
  0,
  1,
  0,
  '2026-08-08 10:00:00+00',
  '2026-08-11 10:00:00+00',
  2,
  (private.problem_review_timeline_snapshot(
    '11000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000002'
  ) ->> 'event_count')::integer,
  private.problem_review_timeline_snapshot(
    '11000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000002'
  ) ->> 'fingerprint',
  '44000000-0000-4000-8000-000000000004'
on conflict (user_id, problem_id) do update
set card_initialized = excluded.card_initialized,
    calculated_parameter_set_id = excluded.calculated_parameter_set_id,
    fsrs_state = excluded.fsrs_state,
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    scheduled_days = excluded.scheduled_days,
    learning_step_index = excluded.learning_step_index,
    reps = excluded.reps,
    lapses = excluded.lapses,
    last_reviewed_at = excluded.last_reviewed_at,
    next_review_at = excluded.next_review_at,
    projection_revision = excluded.projection_revision,
    timeline_event_count = excluded.timeline_event_count,
    timeline_fingerprint = excluded.timeline_fingerprint,
    last_event_id = excluded.last_event_id;

create temporary table cutover_result as
select public.cutover_user_review_schedule_to_fsrs(
  '11000000-0000-4000-8000-000000000001',
  (
    select jsonb_agg(jsonb_build_object(
      'problem_id', projection.problem_id,
      'projection_revision', projection.projection_revision,
      'timeline_fingerprint', projection.timeline_fingerprint
    ))
    from public.fsrs_review_schedule_projection projection
    where projection.user_id = '11000000-0000-4000-8000-000000000001'
      and projection.card_initialized
  )
) as payload;

select is(
  (select payload ->> 'authority_mode' from cutover_result),
  'fsrs',
  'caught-up user can atomically cut over to FSRS authority'
);
select is(
  (
    select authority_algorithm
    from public.review_schedule
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000002'
  ),
  'fsrs',
  'cutover promotes FSRS due through the unified review_schedule reader'
);
select is(
  (
    select next_review_at
    from public.review_schedule
    where user_id = '11000000-0000-4000-8000-000000000001'
      and problem_id = '33000000-0000-4000-8000-000000000002'
  ),
  '2026-08-11 10:00:00+00'::timestamptz,
  'unified due equals the caught-up FSRS due'
);

select is(
  (
    select public.cancel_fsrs_authority_cutover(
      '11000000-0000-4000-8000-000000000001',
      (payload ->> 'cutover_id')::uuid
    ) ->> 'authority_mode'
    from cutover_result
  ),
  'sm2',
  'cutover can be cancelled before any post-cutover Review'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '11000000-0000-4000-8000-000000000001',
  true
);
select is(
  public.get_problem_review_scheduler_diagnostics(
    '33000000-0000-4000-8000-000000000002'
  ) ->> 'version',
  '1',
  'owner diagnostics exposes a versioned safe read model'
);
select is(
  public.get_problem_review_scheduler_diagnostics(
    '33000000-0000-4000-8000-000000000002'
  ) #>> '{fsrs,parameter_stable_key}',
  'default-v1',
  'owner diagnostics exposes stable parameter key only'
);
select ok(
  not (
    public.get_problem_review_scheduler_diagnostics(
      '33000000-0000-4000-8000-000000000002'
    )::text ~ 'card_before|review_log|card_after|lease_token|parameters'
  ),
  'owner diagnostics omits raw scheduler internals'
);
select lives_ok(
  $$
    select public.get_problem_review_scheduler_diagnostics(
      '33000000-0000-4000-8000-000000000001'
    )
  $$,
  'owner can read another owned Card diagnostic'
);
reset role;

select lives_ok(
  $$
    delete from auth.users
    where id = '11000000-0000-4000-8000-000000000001'
  $$,
  'account deletion purges scheduler personal data'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_schedule_applications
    where user_id = '11000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion purges raw FSRS Applications'
);
select is(
  (
    select count(*)::integer
    from public.user_fsrs_settings
    where user_id = '11000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion purges FSRS settings'
);

select * from finish();

rollback;
