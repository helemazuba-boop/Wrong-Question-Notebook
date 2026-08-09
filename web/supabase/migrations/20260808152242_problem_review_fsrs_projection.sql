-- FSRS-6 shadow projection, event-driven SM-2 compatibility, and controlled
-- per-user authority cutover. Human Review Events remain the only facts.

-- ---------------------------------------------------------------------------
-- Parameter provenance and per-user authority
-- ---------------------------------------------------------------------------

create table public.fsrs_parameter_sets (
  id uuid primary key,
  stable_key text not null unique,
  algorithm_version text not null,
  library_name text not null,
  library_version text not null,
  parameters jsonb not null,
  config_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint fsrs_parameter_sets_stable_key_check
    check (stable_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint fsrs_parameter_sets_version_check
    check (
      algorithm_version = 'FSRS-6.0'
      and library_name = 'ts-fsrs'
      and library_version = '5.4.1'
    ),
  constraint fsrs_parameter_sets_parameters_check
    check (
      jsonb_typeof(parameters) = 'object'
      and jsonb_typeof(parameters -> 'w') = 'array'
      and jsonb_array_length(parameters -> 'w') = 21
      and jsonb_typeof(parameters -> 'learning_steps') = 'array'
      and jsonb_typeof(parameters -> 'relearning_steps') = 'array'
      and (parameters ->> 'request_retention')::double precision > 0
      and (parameters ->> 'request_retention')::double precision <= 1
      and (parameters ->> 'maximum_interval')::integer > 0
      and jsonb_typeof(parameters -> 'enable_fuzz') = 'boolean'
      and jsonb_typeof(parameters -> 'enable_short_term') = 'boolean'
    ),
  constraint fsrs_parameter_sets_hash_check
    check (config_hash ~ '^[0-9a-f]{64}$')
);

insert into public.fsrs_parameter_sets (
  id,
  stable_key,
  algorithm_version,
  library_name,
  library_version,
  parameters,
  config_hash
) values (
  'f5000000-0000-4000-8000-000000000001'::uuid,
  'default-v1',
  'FSRS-6.0',
  'ts-fsrs',
  '5.4.1',
  '{
    "request_retention": 0.9,
    "maximum_interval": 36500,
    "w": [
      0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
      0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
      1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542
    ],
    "enable_fuzz": false,
    "enable_short_term": false,
    "learning_steps": [],
    "relearning_steps": []
  }'::jsonb,
  encode(
    extensions.digest(
      convert_to(
        '{
          "request_retention": 0.9,
          "maximum_interval": 36500,
          "w": [
            0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
            0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
            1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542
          ],
          "enable_fuzz": false,
          "enable_short_term": false,
          "learning_steps": [],
          "relearning_steps": []
        }'::jsonb::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
);

create table public.user_fsrs_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_parameter_set_id uuid not null
    references public.fsrs_parameter_sets(id) on delete restrict,
  authority_mode text not null default 'sm2',
  active_cutover_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_fsrs_settings_authority_check
    check (authority_mode in ('sm2', 'fsrs'))
);

create table public.user_fsrs_parameter_activations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  parameter_set_id uuid not null
    references public.fsrs_parameter_sets(id) on delete restrict,
  activated_at timestamptz not null default clock_timestamp(),
  activation_source text not null,
  constraint user_fsrs_parameter_activations_source_check
    check (activation_source in ('baseline', 'admin', 'migration'))
);

create index user_fsrs_parameter_activations_lookup_idx
  on public.user_fsrs_parameter_activations (user_id, activated_at desc, id desc);
create index user_fsrs_parameter_activations_parameter_idx
  on public.user_fsrs_parameter_activations (parameter_set_id);

-- ---------------------------------------------------------------------------
-- Fact-time assignments and compatibility baseline
-- ---------------------------------------------------------------------------

create table public.problem_review_occurrence_parameter_assignments (
  review_occurrence_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  parameter_set_id uuid not null
    references public.fsrs_parameter_sets(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  assignment_source text not null,
  constraint problem_review_occurrence_parameter_assignments_occurrence_fkey
    foreign key (review_occurrence_id, user_id, problem_id)
    references public.problem_review_occurrences (id, user_id, problem_id)
    on delete cascade,
  constraint problem_review_occurrence_parameter_assignments_source_check
    check (assignment_source in ('fact', 'migration'))
);

create index problem_review_occurrence_parameter_assignments_timeline_idx
  on public.problem_review_occurrence_parameter_assignments (user_id, problem_id);
create index problem_review_occurrence_parameter_assignments_parameter_idx
  on public.problem_review_occurrence_parameter_assignments (parameter_set_id);

create table public.problem_review_sm2_compatibility_baselines (
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  anchor_review_occurrence_id uuid not null,
  captured_at timestamptz not null,
  timezone text not null,
  schedule_existed boolean not null,
  repetition_number integer not null,
  ease_factor double precision not null,
  interval_days integer not null,
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, problem_id),
  constraint problem_review_sm2_baselines_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_sm2_baselines_anchor_fkey
    foreign key (anchor_review_occurrence_id, user_id, problem_id)
    references public.problem_review_occurrences (id, user_id, problem_id)
    on delete cascade,
  constraint problem_review_sm2_baselines_values_check
    check (
      repetition_number >= 0
      and ease_factor >= 1
      and interval_days >= 0
      and btrim(timezone) <> ''
    )
);

create index problem_review_sm2_baselines_anchor_idx
  on public.problem_review_sm2_compatibility_baselines (
    anchor_review_occurrence_id
  );

-- ---------------------------------------------------------------------------
-- Runs, immutable Applications, and current FSRS shadow Card
-- ---------------------------------------------------------------------------

create table public.problem_review_projection_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  lease_token uuid not null,
  status text not null default 'processing',
  reason text not null default 'dirty_timeline',
  base_projection_revision bigint not null,
  timeline_event_count integer not null,
  timeline_fingerprint text not null,
  error_code text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint problem_review_projection_runs_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_projection_runs_status_check
    check (status in ('processing', 'committed', 'failed', 'stale')),
  constraint problem_review_projection_runs_reason_check
    check (reason in ('dirty_timeline', 'explicit')),
  constraint problem_review_projection_runs_revision_check
    check (base_projection_revision >= 0),
  constraint problem_review_projection_runs_count_check
    check (timeline_event_count >= 0),
  constraint problem_review_projection_runs_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint problem_review_projection_runs_terminal_check
    check (
      (status = 'processing' and completed_at is null and error_code is null)
      or (status = 'committed' and completed_at is not null and error_code is null)
      or (status in ('failed', 'stale') and completed_at is not null)
    )
);

create unique index problem_review_projection_runs_processing_lease_uidx
  on public.problem_review_projection_runs (user_id, problem_id, lease_token)
  where status = 'processing';
create index problem_review_projection_runs_timeline_idx
  on public.problem_review_projection_runs (user_id, problem_id, started_at desc);

create table public.problem_review_schedule_applications (
  id uuid primary key default gen_random_uuid(),
  projection_run_id uuid not null
    references public.problem_review_projection_runs(id) on delete cascade,
  sequence integer not null,
  projection_revision bigint not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  event_id uuid not null,
  review_occurrence_id uuid not null,
  parameter_set_id uuid not null
    references public.fsrs_parameter_sets(id) on delete restrict,
  algorithm_version text not null,
  library_name text not null,
  library_version text not null,
  card_before jsonb not null,
  review_log jsonb not null,
  card_after jsonb not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint problem_review_schedule_applications_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_review_schedule_applications_event_fkey
    foreign key (event_id, review_occurrence_id, user_id, problem_id)
    references public.problem_review_events (
      id,
      review_occurrence_id,
      user_id,
      problem_id
    ) on delete cascade,
  constraint problem_review_schedule_applications_sequence_key
    unique (projection_run_id, sequence),
  constraint problem_review_schedule_applications_event_key
    unique (projection_run_id, event_id),
  constraint problem_review_schedule_applications_values_check
    check (
      sequence >= 1
      and projection_revision >= 1
      and algorithm_version = 'FSRS-6.0'
      and library_name = 'ts-fsrs'
      and library_version = '5.4.1'
      and jsonb_typeof(card_before) = 'object'
      and jsonb_typeof(review_log) = 'object'
      and jsonb_typeof(card_after) = 'object'
    )
);

create index problem_review_schedule_applications_timeline_idx
  on public.problem_review_schedule_applications (
    user_id,
    problem_id,
    projection_revision,
    sequence
  );
create index problem_review_schedule_applications_occurrence_idx
  on public.problem_review_schedule_applications (review_occurrence_id);
create index problem_review_schedule_applications_parameter_idx
  on public.problem_review_schedule_applications (parameter_set_id);

create table public.fsrs_review_schedule_projection (
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  card_initialized boolean not null,
  scheduler_algorithm text not null default 'FSRS-6.0',
  library_name text not null default 'ts-fsrs',
  library_version text not null default '5.4.1',
  calculated_parameter_set_id uuid
    references public.fsrs_parameter_sets(id) on delete restrict,
  fsrs_state text,
  stability double precision,
  difficulty double precision,
  scheduled_days integer,
  learning_step_index integer,
  reps integer,
  lapses integer,
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  projection_revision bigint not null,
  timeline_event_count integer not null,
  timeline_fingerprint text not null,
  last_event_id uuid,
  last_application_id uuid
    references public.problem_review_schedule_applications(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, problem_id),
  constraint fsrs_review_schedule_projection_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint fsrs_review_schedule_projection_revision_check
    check (projection_revision >= 1 and timeline_event_count >= 0),
  constraint fsrs_review_schedule_projection_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint fsrs_review_schedule_projection_runtime_check
    check (
      scheduler_algorithm = 'FSRS-6.0'
      and library_name = 'ts-fsrs'
      and library_version = '5.4.1'
    ),
  constraint fsrs_review_schedule_projection_card_check
    check (
      (
        card_initialized
        and calculated_parameter_set_id is not null
        and fsrs_state in ('New', 'Learning', 'Review', 'Relearning')
        and stability >= 0
        and difficulty between 0 and 10
        and scheduled_days >= 0
        and learning_step_index >= 0
        and reps >= 0
        and lapses >= 0
        and next_review_at is not null
      )
      or (
        not card_initialized
        and calculated_parameter_set_id is null
        and fsrs_state is null
        and stability is null
        and difficulty is null
        and scheduled_days is null
        and learning_step_index is null
        and reps is null
        and lapses is null
        and last_reviewed_at is null
        and next_review_at is null
        and last_event_id is null
        and last_application_id is null
      )
    )
);

create index fsrs_review_schedule_projection_due_idx
  on public.fsrs_review_schedule_projection (user_id, next_review_at)
  where card_initialized;
create index fsrs_review_schedule_projection_parameter_idx
  on public.fsrs_review_schedule_projection (calculated_parameter_set_id)
  where calculated_parameter_set_id is not null;

-- ---------------------------------------------------------------------------
-- Controlled cutover and bounded cancellation
-- ---------------------------------------------------------------------------

create table public.fsrs_authority_cutovers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active',
  problem_count integer not null,
  cutover_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz,
  constraint fsrs_authority_cutovers_status_check
    check (status in ('active', 'cancelled')),
  constraint fsrs_authority_cutovers_count_check
    check (problem_count >= 0),
  constraint fsrs_authority_cutovers_cancel_check
    check (
      (status = 'active' and cancelled_at is null)
      or (status = 'cancelled' and cancelled_at is not null)
    )
);

create unique index fsrs_authority_cutovers_active_user_uidx
  on public.fsrs_authority_cutovers (user_id)
  where status = 'active';

alter table public.user_fsrs_settings
  add constraint user_fsrs_settings_active_cutover_fkey
  foreign key (active_cutover_id)
  references public.fsrs_authority_cutovers(id)
  on delete set null;

create table public.fsrs_authority_cutover_snapshots (
  cutover_id uuid not null
    references public.fsrs_authority_cutovers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  schedule_existed boolean not null,
  previous_next_review_at timestamptz,
  previous_interval_days integer,
  previous_ease_factor double precision,
  previous_repetition_number integer,
  previous_last_reviewed_at timestamptz,
  previous_authority_algorithm text,
  previous_authority_projection_revision bigint,
  previous_authority_parameter_set_id uuid,
  fsrs_projection_revision bigint not null,
  timeline_event_count integer not null,
  timeline_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (cutover_id, problem_id),
  constraint fsrs_authority_cutover_snapshots_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint fsrs_authority_cutover_snapshots_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$')
);

create index fsrs_authority_cutover_snapshots_user_idx
  on public.fsrs_authority_cutover_snapshots (user_id, cutover_id);

alter table public.review_schedule
  add column authority_algorithm text not null default 'sm2',
  add column authority_projection_revision bigint,
  add column authority_parameter_set_id uuid
    references public.fsrs_parameter_sets(id) on delete restrict,
  add constraint review_schedule_authority_algorithm_check
    check (authority_algorithm in ('sm2', 'fsrs')),
  add constraint review_schedule_authority_fields_check
    check (
      (authority_algorithm = 'sm2' and authority_parameter_set_id is null)
      or (
        authority_algorithm = 'fsrs'
        and authority_projection_revision is not null
        and authority_parameter_set_id is not null
      )
    );

-- ---------------------------------------------------------------------------
-- RLS and least privilege. Raw scheduler internals are server-only.
-- ---------------------------------------------------------------------------

alter table public.fsrs_parameter_sets enable row level security;
alter table public.user_fsrs_settings enable row level security;
alter table public.user_fsrs_parameter_activations enable row level security;
alter table public.problem_review_occurrence_parameter_assignments enable row level security;
alter table public.problem_review_sm2_compatibility_baselines enable row level security;
alter table public.problem_review_projection_runs enable row level security;
alter table public.problem_review_schedule_applications enable row level security;
alter table public.fsrs_review_schedule_projection enable row level security;
alter table public.fsrs_authority_cutovers enable row level security;
alter table public.fsrs_authority_cutover_snapshots enable row level security;

revoke all on table public.fsrs_parameter_sets from public, anon, authenticated;
revoke all on table public.user_fsrs_settings from public, anon, authenticated;
revoke all on table public.user_fsrs_parameter_activations from public, anon, authenticated;
revoke all on table public.problem_review_occurrence_parameter_assignments
  from public, anon, authenticated;
revoke all on table public.problem_review_sm2_compatibility_baselines
  from public, anon, authenticated;
revoke all on table public.problem_review_projection_runs
  from public, anon, authenticated;
revoke all on table public.problem_review_schedule_applications
  from public, anon, authenticated;
revoke all on table public.fsrs_review_schedule_projection
  from public, anon, authenticated;
revoke all on table public.fsrs_authority_cutovers
  from public, anon, authenticated;
revoke all on table public.fsrs_authority_cutover_snapshots
  from public, anon, authenticated;

grant all on table public.fsrs_parameter_sets to service_role;
grant all on table public.user_fsrs_settings to service_role;
grant all on table public.user_fsrs_parameter_activations to service_role;
grant usage, select on sequence public.user_fsrs_parameter_activations_id_seq
  to service_role;
grant all on table public.problem_review_occurrence_parameter_assignments
  to service_role;
grant all on table public.problem_review_sm2_compatibility_baselines
  to service_role;
grant all on table public.problem_review_projection_runs to service_role;
grant all on table public.problem_review_schedule_applications to service_role;
grant all on table public.fsrs_review_schedule_projection to service_role;
grant all on table public.fsrs_authority_cutovers to service_role;
grant all on table public.fsrs_authority_cutover_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- Append-only guards
-- ---------------------------------------------------------------------------

create or replace function private.prevent_fsrs_immutable_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'FSRS_SCHEDULER_FACTS_APPEND_ONLY';
end;
$$;

create trigger prevent_fsrs_parameter_set_update
before update on public.fsrs_parameter_sets
for each row execute function private.prevent_fsrs_immutable_update();
create trigger prevent_fsrs_activation_update
before update on public.user_fsrs_parameter_activations
for each row execute function private.prevent_fsrs_immutable_update();
create trigger prevent_fsrs_assignment_update
before update on public.problem_review_occurrence_parameter_assignments
for each row execute function private.prevent_fsrs_immutable_update();
create trigger prevent_fsrs_sm2_baseline_update
before update on public.problem_review_sm2_compatibility_baselines
for each row execute function private.prevent_fsrs_immutable_update();
create trigger prevent_fsrs_application_update
before update on public.problem_review_schedule_applications
for each row execute function private.prevent_fsrs_immutable_update();
create trigger prevent_fsrs_cutover_snapshot_update
before update on public.fsrs_authority_cutover_snapshots
for each row execute function private.prevent_fsrs_immutable_update();

revoke all on function private.prevent_fsrs_immutable_update()
  from public, anon, authenticated;
grant execute on function private.prevent_fsrs_immutable_update()
  to service_role;

-- ---------------------------------------------------------------------------
-- Timeline fingerprint used by prepare, commit, diagnostics, and cutover.
-- ---------------------------------------------------------------------------

create or replace function private.problem_review_timeline_snapshot(
  p_user_id uuid,
  p_problem_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with timeline as (
    select
      event.id,
      event.review_occurrence_id,
      event.event_kind,
      event.human_rating,
      event.effective_review_at,
      event.received_at,
      assignment.parameter_set_id
    from public.effective_problem_review_events event
    left join public.problem_review_occurrence_parameter_assignments assignment
      on assignment.review_occurrence_id = event.review_occurrence_id
    where event.user_id = p_user_id
      and event.problem_id = p_problem_id
    order by event.effective_review_at, event.received_at, event.id
  ), serialized as (
    select coalesce(
      string_agg(
        id::text || '|' ||
        review_occurrence_id::text || '|' ||
        event_kind || '|' ||
        coalesce(human_rating, '') || '|' ||
        effective_review_at::text || '|' ||
        received_at::text || '|' ||
        coalesce(parameter_set_id::text, ''),
        E'\n'
        order by effective_review_at, received_at, id
      ),
      ''
    ) as payload,
    count(*)::integer as event_count,
    count(*) filter (where event_kind = 'review')::integer as review_count
    from timeline
  )
  select jsonb_build_object(
    'event_count', event_count,
    'review_count', review_count,
    'fingerprint', encode(
      extensions.digest(convert_to(payload, 'UTF8'), 'sha256'),
      'hex'
    )
  )
  from serialized;
$$;

revoke all on function private.problem_review_timeline_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.problem_review_timeline_snapshot(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Review fact transaction extension: assignment + SM-2 baseline + dirty job.
-- ---------------------------------------------------------------------------

create or replace function private.initialize_problem_review_scheduler_fact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parameter_set_id uuid;
  v_authority_mode text;
  v_timezone text := 'UTC';
  v_schedule public.review_schedule%rowtype;
  v_schedule_existed boolean := false;
begin
  if new.event_kind = 'review' then
    insert into public.user_fsrs_settings (
      user_id,
      active_parameter_set_id,
      authority_mode
    ) values (
      new.user_id,
      'f5000000-0000-4000-8000-000000000001'::uuid,
      'sm2'
    ) on conflict (user_id) do nothing;

    if not exists (
      select 1
      from public.user_fsrs_parameter_activations activation
      where activation.user_id = new.user_id
    ) then
      insert into public.user_fsrs_parameter_activations (
        user_id,
        parameter_set_id,
        activation_source
      ) values (
        new.user_id,
        'f5000000-0000-4000-8000-000000000001'::uuid,
        'baseline'
      );
    end if;

    select settings.active_parameter_set_id, settings.authority_mode
    into v_parameter_set_id, v_authority_mode
    from public.user_fsrs_settings settings
    where settings.user_id = new.user_id
    for share;

    insert into public.problem_review_occurrence_parameter_assignments (
      review_occurrence_id,
      user_id,
      problem_id,
      parameter_set_id,
      assignment_source
    ) values (
      new.review_occurrence_id,
      new.user_id,
      new.problem_id,
      v_parameter_set_id,
      'fact'
    ) on conflict (review_occurrence_id) do nothing;

    if not exists (
      select 1
      from public.problem_review_occurrence_parameter_assignments assignment
      where assignment.review_occurrence_id = new.review_occurrence_id
        and assignment.user_id = new.user_id
        and assignment.problem_id = new.problem_id
        and assignment.parameter_set_id = v_parameter_set_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'REVIEW_PARAMETER_ASSIGNMENT_CONFLICT';
    end if;

    if v_authority_mode = 'sm2' then
      select coalesce(nullif(btrim(profile.timezone), ''), 'UTC')
      into v_timezone
      from public.user_profiles profile
      where profile.id = new.user_id;
      v_timezone := coalesce(v_timezone, 'UTC');

      select exists (
        select 1
        from public.review_schedule schedule
        where schedule.user_id = new.user_id
          and schedule.problem_id = new.problem_id
      ) into v_schedule_existed;

      select * into v_schedule
      from public.review_schedule schedule
      where schedule.user_id = new.user_id
        and schedule.problem_id = new.problem_id
      for share;

      insert into public.problem_review_sm2_compatibility_baselines (
        user_id,
        problem_id,
        anchor_review_occurrence_id,
        captured_at,
        timezone,
        schedule_existed,
        repetition_number,
        ease_factor,
        interval_days,
        last_reviewed_at,
        next_review_at
      ) values (
        new.user_id,
        new.problem_id,
        new.review_occurrence_id,
        clock_timestamp(),
        v_timezone,
        v_schedule_existed,
        coalesce(v_schedule.repetition_number, 0),
        coalesce(v_schedule.ease_factor, 2.5),
        coalesce(v_schedule.interval_days, 1),
        v_schedule.last_reviewed_at,
        v_schedule.next_review_at
      ) on conflict (user_id, problem_id) do nothing;
    end if;
  end if;

  perform private.mark_problem_review_timeline_dirty(
    new.user_id,
    new.problem_id,
    new.effective_review_at
  );

  return new;
end;
$$;

create trigger initialize_problem_review_scheduler_fact
after insert on public.problem_review_events
for each row execute function private.initialize_problem_review_scheduler_fact();

revoke all on function private.initialize_problem_review_scheduler_fact()
  from public, anon, authenticated;
grant execute on function private.initialize_problem_review_scheduler_fact()
  to service_role;

-- Existing reliable Review Events predate fact-time activation history. Assign
-- the frozen default baseline explicitly; their legacy due remains authority.
insert into public.user_fsrs_settings (
  user_id,
  active_parameter_set_id,
  authority_mode
)
select distinct
  event.user_id,
  'f5000000-0000-4000-8000-000000000001'::uuid,
  'sm2'
from public.problem_review_events event
where event.event_kind = 'review'
on conflict (user_id) do nothing;

insert into public.user_fsrs_parameter_activations (
  user_id,
  parameter_set_id,
  activated_at,
  activation_source
)
select
  settings.user_id,
  settings.active_parameter_set_id,
  settings.created_at,
  'migration'
from public.user_fsrs_settings settings
where not exists (
  select 1
  from public.user_fsrs_parameter_activations activation
  where activation.user_id = settings.user_id
);

insert into public.problem_review_occurrence_parameter_assignments (
  review_occurrence_id,
  user_id,
  problem_id,
  parameter_set_id,
  assigned_at,
  assignment_source
)
select
  event.review_occurrence_id,
  event.user_id,
  event.problem_id,
  'f5000000-0000-4000-8000-000000000001'::uuid,
  event.received_at,
  'migration'
from public.effective_problem_review_events event
where event.event_kind = 'review'
on conflict (review_occurrence_id) do nothing;

-- ---------------------------------------------------------------------------
-- Parameter activation (service role only; activation does not replay Cards).
-- ---------------------------------------------------------------------------

create or replace function public.activate_user_fsrs_parameter_set(
  p_user_id uuid,
  p_parameter_set_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_activation_id bigint;
begin
  if not exists (
    select 1 from public.fsrs_parameter_sets parameters
    where parameters.id = p_parameter_set_id
  ) then
    raise exception using errcode = '22023', message = 'FSRS_PARAMETER_SET_NOT_FOUND';
  end if;

  insert into public.user_fsrs_settings (
    user_id,
    active_parameter_set_id,
    authority_mode
  ) values (
    p_user_id,
    p_parameter_set_id,
    'sm2'
  ) on conflict (user_id) do update
  set active_parameter_set_id = excluded.active_parameter_set_id,
      updated_at = clock_timestamp();

  insert into public.user_fsrs_parameter_activations (
    user_id,
    parameter_set_id,
    activation_source
  ) values (
    p_user_id,
    p_parameter_set_id,
    'admin'
  ) returning id into v_activation_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'parameter_set_id', p_parameter_set_id,
    'activation_id', v_activation_id
  );
end;
$$;

revoke all on function public.activate_user_fsrs_parameter_set(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.activate_user_fsrs_parameter_set(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Durable claim / prepare / failure functions.
-- ---------------------------------------------------------------------------

create or replace function public.claim_problem_review_projection_jobs(
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_limit < 1 or p_limit > 50
     or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'INVALID_PROJECTION_CLAIM';
  end if;

  with candidates as (
    select job.user_id, job.problem_id
    from public.problem_review_projection_jobs job
    where (
      job.status in ('pending', 'retry')
      and job.next_retry_at <= clock_timestamp()
    ) or (
      job.status = 'processing'
      and job.lease_until <= clock_timestamp()
    )
    order by job.next_retry_at, job.updated_at, job.user_id, job.problem_id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.problem_review_projection_jobs job
    set status = 'processing',
        lease_token = gen_random_uuid(),
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = job.attempt_count + 1,
        updated_at = clock_timestamp()
    from candidates
    where job.user_id = candidates.user_id
      and job.problem_id = candidates.problem_id
    returning
      job.user_id,
      job.problem_id,
      job.dirty_from,
      job.lease_token,
      job.lease_until,
      job.attempt_count
  )
  select coalesce(
    jsonb_agg(to_jsonb(claimed) order by dirty_from, user_id, problem_id),
    '[]'::jsonb
  ) into v_result
  from claimed;

  return v_result;
end;
$$;

revoke all on function public.claim_problem_review_projection_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_problem_review_projection_jobs(integer, integer)
  to service_role;

create or replace function public.prepare_problem_review_projection(
  p_user_id uuid,
  p_problem_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.problem_review_projection_jobs%rowtype;
  v_snapshot jsonb;
  v_projection public.fsrs_review_schedule_projection%rowtype;
  v_settings public.user_fsrs_settings%rowtype;
  v_baseline public.problem_review_sm2_compatibility_baselines%rowtype;
  v_run public.problem_review_projection_runs%rowtype;
  v_events jsonb;
begin
  select * into v_job
  from public.problem_review_projection_jobs job
  where job.user_id = p_user_id
    and job.problem_id = p_problem_id
  for update;

  if not found
     or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'PROJECTION_LEASE_LOST';
  end if;

  if exists (
    select 1
    from public.effective_problem_review_events event
    left join public.problem_review_occurrence_parameter_assignments assignment
      on assignment.review_occurrence_id = event.review_occurrence_id
    where event.user_id = p_user_id
      and event.problem_id = p_problem_id
      and event.event_kind = 'review'
      and assignment.review_occurrence_id is null
  ) then
    raise exception using errcode = '55000', message = 'PROJECTION_ASSIGNMENT_MISSING';
  end if;

  select * into v_settings
  from public.user_fsrs_settings settings
  where settings.user_id = p_user_id;

  if not found then
    insert into public.user_fsrs_settings (
      user_id,
      active_parameter_set_id,
      authority_mode
    ) values (
      p_user_id,
      'f5000000-0000-4000-8000-000000000001'::uuid,
      'sm2'
    ) returning * into v_settings;
  end if;

  select * into v_projection
  from public.fsrs_review_schedule_projection projection
  where projection.user_id = p_user_id
    and projection.problem_id = p_problem_id;

  select * into v_baseline
  from public.problem_review_sm2_compatibility_baselines baseline
  where baseline.user_id = p_user_id
    and baseline.problem_id = p_problem_id;

  v_snapshot := private.problem_review_timeline_snapshot(p_user_id, p_problem_id);

  select * into v_run
  from public.problem_review_projection_runs run
  where run.user_id = p_user_id
    and run.problem_id = p_problem_id
    and run.lease_token = p_lease_token
    and run.status = 'processing';

  if not found then
    insert into public.problem_review_projection_runs (
      user_id,
      problem_id,
      lease_token,
      base_projection_revision,
      timeline_event_count,
      timeline_fingerprint
    ) values (
      p_user_id,
      p_problem_id,
      p_lease_token,
      coalesce(v_projection.projection_revision, 0),
      (v_snapshot ->> 'event_count')::integer,
      v_snapshot ->> 'fingerprint'
    ) returning * into v_run;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'event_id', event.id,
        'review_occurrence_id', event.review_occurrence_id,
        'event_kind', event.event_kind,
        'human_rating', event.human_rating,
        'effective_review_at', event.effective_review_at,
        'received_at', event.received_at,
        'parameter_set_id', assignment.parameter_set_id,
        'parameter_stable_key', parameters.stable_key,
        'parameters', parameters.parameters,
        'include_in_sm2', case
          when v_baseline.user_id is null or event.event_kind <> 'review' then false
          when event.review_occurrence_id = v_baseline.anchor_review_occurrence_id then true
          when event.received_at > v_baseline.captured_at then true
          else false
        end
      )
      order by event.effective_review_at, event.received_at, event.id
    ),
    '[]'::jsonb
  ) into v_events
  from public.effective_problem_review_events event
  left join public.problem_review_occurrence_parameter_assignments assignment
    on assignment.review_occurrence_id = event.review_occurrence_id
  left join public.fsrs_parameter_sets parameters
    on parameters.id = assignment.parameter_set_id
  where event.user_id = p_user_id
    and event.problem_id = p_problem_id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'user_id', p_user_id,
    'problem_id', p_problem_id,
    'lease_token', p_lease_token,
    'authority_mode', v_settings.authority_mode,
    'base_projection_revision', v_run.base_projection_revision,
    'timeline_event_count', v_run.timeline_event_count,
    'timeline_fingerprint', v_run.timeline_fingerprint,
    'events', v_events,
    'sm2_baseline', case
      when v_baseline.user_id is null then null
      else jsonb_build_object(
        'timezone', v_baseline.timezone,
        'schedule_existed', v_baseline.schedule_existed,
        'repetition_number', v_baseline.repetition_number,
        'ease_factor', v_baseline.ease_factor,
        'interval_days', v_baseline.interval_days,
        'last_reviewed_at', v_baseline.last_reviewed_at,
        'next_review_at', v_baseline.next_review_at
      )
    end
  );
end;
$$;

revoke all on function public.prepare_problem_review_projection(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_problem_review_projection(uuid, uuid, uuid)
  to service_role;

create or replace function public.fail_problem_review_projection_job(
  p_user_id uuid,
  p_problem_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_attempt_count integer;
begin
  if p_error_code not in (
    'INVALID_PREPARE_RESULT',
    'INVALID_PARAMETERS',
    'FSRS_CALCULATION_FAILED',
    'SM2_CALCULATION_FAILED',
    'COMMIT_FAILED',
    'PROJECTION_ASSIGNMENT_MISSING',
    'UNKNOWN'
  ) then
    p_error_code := 'UNKNOWN';
  end if;

  select job.attempt_count into v_attempt_count
  from public.problem_review_projection_jobs job
  where job.user_id = p_user_id
    and job.problem_id = p_problem_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
  for update;

  if not found then return false; end if;

  update public.problem_review_projection_runs run
  set status = 'failed',
      error_code = p_error_code,
      completed_at = clock_timestamp()
  where run.user_id = p_user_id
    and run.problem_id = p_problem_id
    and run.lease_token = p_lease_token
    and run.status = 'processing';

  update public.problem_review_projection_jobs job
  set status = 'retry',
      lease_token = null,
      lease_until = null,
      next_retry_at = clock_timestamp() + make_interval(
        secs => least(3600, (15 * power(2, least(v_attempt_count, 8)))::integer)
      ),
      last_error_code = p_error_code,
      updated_at = clock_timestamp()
  where job.user_id = p_user_id
    and job.problem_id = p_problem_id;

  return true;
end;
$$;

revoke all on function public.fail_problem_review_projection_job(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_problem_review_projection_job(uuid, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- CAS commit. All raw Application payloads stay server-only.
-- ---------------------------------------------------------------------------

create or replace function public.commit_problem_review_projection(
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_event_count integer,
  p_expected_fingerprint text,
  p_expected_base_revision bigint,
  p_applications jsonb,
  p_fsrs_card jsonb,
  p_sm2_projection jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.problem_review_projection_runs%rowtype;
  v_job public.problem_review_projection_jobs%rowtype;
  v_projection public.fsrs_review_schedule_projection%rowtype;
  v_snapshot jsonb;
  v_authority_mode text;
  v_review_count integer;
  v_application jsonb;
  v_expected_event public.problem_review_events%rowtype;
  v_expected_parameter_id uuid;
  v_index integer := 0;
  v_target_revision bigint;
  v_last_application_id uuid;
  v_last_event_id uuid;
  v_last_parameter_id uuid;
  v_card_initialized boolean;
begin
  if jsonb_typeof(p_applications) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_PROJECTION_APPLICATIONS';
  end if;

  select * into v_run
  from public.problem_review_projection_runs run
  where run.id = p_run_id
  for update;

  if not found or v_run.status <> 'processing'
     or v_run.lease_token is distinct from p_lease_token then
    raise exception using errcode = '55000', message = 'PROJECTION_RUN_LOST';
  end if;

  select * into v_job
  from public.problem_review_projection_jobs job
  where job.user_id = v_run.user_id
    and job.problem_id = v_run.problem_id
  for update;

  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'PROJECTION_LEASE_LOST';
  end if;

  select * into v_projection
  from public.fsrs_review_schedule_projection projection
  where projection.user_id = v_run.user_id
    and projection.problem_id = v_run.problem_id
  for update;

  v_snapshot := private.problem_review_timeline_snapshot(v_run.user_id, v_run.problem_id);

  if p_expected_event_count <> (v_snapshot ->> 'event_count')::integer
     or p_expected_fingerprint <> v_snapshot ->> 'fingerprint'
     or p_expected_event_count <> v_run.timeline_event_count
     or p_expected_fingerprint <> v_run.timeline_fingerprint
     or p_expected_base_revision <> v_run.base_projection_revision
     or p_expected_base_revision <> coalesce(v_projection.projection_revision, 0) then
    update public.problem_review_projection_runs
    set status = 'stale',
        error_code = 'TIMELINE_CHANGED',
        completed_at = clock_timestamp()
    where id = p_run_id;

    update public.problem_review_projection_jobs
    set status = 'pending',
        lease_token = null,
        lease_until = null,
        next_retry_at = clock_timestamp(),
        last_error_code = null,
        updated_at = clock_timestamp()
    where user_id = v_run.user_id
      and problem_id = v_run.problem_id;

    return jsonb_build_object('committed', false, 'stale', true);
  end if;

  v_review_count := (v_snapshot ->> 'review_count')::integer;
  if jsonb_array_length(p_applications) <> v_review_count then
    raise exception using errcode = '22023', message = 'PROJECTION_APPLICATION_COUNT_MISMATCH';
  end if;

  v_target_revision := p_expected_base_revision + 1;

  for v_application in
    select value from jsonb_array_elements(p_applications)
  loop
    v_index := v_index + 1;

    select event.* into v_expected_event
    from public.effective_problem_review_events event
    where event.user_id = v_run.user_id
      and event.problem_id = v_run.problem_id
      and event.event_kind = 'review'
    order by event.effective_review_at, event.received_at, event.id
    offset v_index - 1 limit 1;

    select assignment.parameter_set_id into v_expected_parameter_id
    from public.problem_review_occurrence_parameter_assignments assignment
    where assignment.review_occurrence_id = v_expected_event.review_occurrence_id;

    if (v_application ->> 'event_id')::uuid <> v_expected_event.id
       or (v_application ->> 'review_occurrence_id')::uuid
          <> v_expected_event.review_occurrence_id
       or (v_application ->> 'parameter_set_id')::uuid
          <> v_expected_parameter_id
       or jsonb_typeof(v_application -> 'card_before') <> 'object'
       or jsonb_typeof(v_application -> 'review_log') <> 'object'
       or jsonb_typeof(v_application -> 'card_after') <> 'object' then
      raise exception using errcode = '22023', message = 'PROJECTION_APPLICATION_MISMATCH';
    end if;

    insert into public.problem_review_schedule_applications (
      projection_run_id,
      sequence,
      projection_revision,
      user_id,
      problem_id,
      event_id,
      review_occurrence_id,
      parameter_set_id,
      algorithm_version,
      library_name,
      library_version,
      card_before,
      review_log,
      card_after
    ) values (
      p_run_id,
      v_index,
      v_target_revision,
      v_run.user_id,
      v_run.problem_id,
      v_expected_event.id,
      v_expected_event.review_occurrence_id,
      v_expected_parameter_id,
      'FSRS-6.0',
      'ts-fsrs',
      '5.4.1',
      v_application -> 'card_before',
      v_application -> 'review_log',
      v_application -> 'card_after'
    ) returning id into v_last_application_id;

    v_last_event_id := v_expected_event.id;
    v_last_parameter_id := v_expected_parameter_id;
  end loop;

  v_card_initialized := p_fsrs_card is not null;
  if v_review_count = 0 and p_fsrs_card is not null then
    raise exception using errcode = '22023', message = 'PROJECTION_CARD_WITHOUT_REVIEW';
  elsif v_review_count > 0 and (
    p_fsrs_card is null or jsonb_typeof(p_fsrs_card) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'PROJECTION_CARD_MISSING';
  end if;

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
    last_event_id,
    last_application_id,
    updated_at
  ) values (
    v_run.user_id,
    v_run.problem_id,
    v_card_initialized,
    case when v_card_initialized then v_last_parameter_id else null end,
    case when v_card_initialized then p_fsrs_card ->> 'state' else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'stability')::double precision else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'difficulty')::double precision else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'scheduled_days')::integer else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'learning_step_index')::integer else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'reps')::integer else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'lapses')::integer else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'last_review')::timestamptz else null end,
    case when v_card_initialized then (p_fsrs_card ->> 'due')::timestamptz else null end,
    v_target_revision,
    p_expected_event_count,
    p_expected_fingerprint,
    v_last_event_id,
    v_last_application_id,
    clock_timestamp()
  ) on conflict (user_id, problem_id) do update
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
      last_event_id = excluded.last_event_id,
      last_application_id = excluded.last_application_id,
      updated_at = excluded.updated_at;

  select settings.authority_mode into v_authority_mode
  from public.user_fsrs_settings settings
  where settings.user_id = v_run.user_id
  for update;
  v_authority_mode := coalesce(v_authority_mode, 'sm2');

  if v_authority_mode = 'sm2' and p_sm2_projection is not null then
    if jsonb_typeof(p_sm2_projection) <> 'object' then
      raise exception using errcode = '22023', message = 'INVALID_SM2_PROJECTION';
    end if;

    insert into public.review_schedule (
      user_id,
      problem_id,
      next_review_at,
      interval_days,
      ease_factor,
      repetition_number,
      last_reviewed_at,
      updated_at,
      authority_algorithm,
      authority_projection_revision,
      authority_parameter_set_id
    ) values (
      v_run.user_id,
      v_run.problem_id,
      (p_sm2_projection ->> 'next_review_at')::timestamptz,
      (p_sm2_projection ->> 'interval_days')::integer,
      (p_sm2_projection ->> 'ease_factor')::double precision,
      (p_sm2_projection ->> 'repetition_number')::integer,
      (p_sm2_projection ->> 'last_reviewed_at')::timestamptz,
      clock_timestamp(),
      'sm2',
      v_target_revision,
      null
    ) on conflict (user_id, problem_id) do update
    set next_review_at = excluded.next_review_at,
        interval_days = excluded.interval_days,
        ease_factor = excluded.ease_factor,
        repetition_number = excluded.repetition_number,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at,
        authority_algorithm = 'sm2',
        authority_projection_revision = excluded.authority_projection_revision,
        authority_parameter_set_id = null;
  elsif v_authority_mode = 'fsrs' and v_card_initialized then
    insert into public.review_schedule (
      user_id,
      problem_id,
      next_review_at,
      interval_days,
      ease_factor,
      repetition_number,
      last_reviewed_at,
      updated_at,
      authority_algorithm,
      authority_projection_revision,
      authority_parameter_set_id
    ) values (
      v_run.user_id,
      v_run.problem_id,
      (p_fsrs_card ->> 'due')::timestamptz,
      1,
      2.5,
      0,
      (p_fsrs_card ->> 'last_review')::timestamptz,
      clock_timestamp(),
      'fsrs',
      v_target_revision,
      v_last_parameter_id
    ) on conflict (user_id, problem_id) do update
    set next_review_at = excluded.next_review_at,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at,
        authority_algorithm = 'fsrs',
        authority_projection_revision = excluded.authority_projection_revision,
        authority_parameter_set_id = excluded.authority_parameter_set_id;
  end if;

  update public.problems problem
  set status = (case terminal.human_rating
        when 'Again' then 'wrong'
        when 'Hard' then 'needs_review'
        when 'Good' then 'mastered'
        when 'Easy' then 'mastered'
      end)::public.problem_status_enum,
      last_reviewed_date = terminal.effective_review_at,
      updated_at = clock_timestamp()
  from (
    select event.human_rating, event.effective_review_at
    from public.effective_problem_review_events event
    where event.user_id = v_run.user_id
      and event.problem_id = v_run.problem_id
      and event.event_kind = 'review'
    order by event.effective_review_at desc, event.received_at desc, event.id desc
    limit 1
  ) terminal
  where problem.id = v_run.problem_id
    and problem.user_id = v_run.user_id;

  update public.problem_review_projection_runs
  set status = 'committed',
      completed_at = clock_timestamp()
  where id = p_run_id;

  delete from public.problem_review_projection_jobs
  where user_id = v_run.user_id
    and problem_id = v_run.problem_id
    and lease_token = p_lease_token;

  return jsonb_build_object(
    'committed', true,
    'stale', false,
    'projection_revision', v_target_revision,
    'authority_mode', v_authority_mode,
    'next_review_at', case
      when v_card_initialized then p_fsrs_card ->> 'due'
      else null
    end
  );
end;
$$;

revoke all on function public.commit_problem_review_projection(
  uuid, uuid, integer, text, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_problem_review_projection(
  uuid, uuid, integer, text, bigint, jsonb, jsonb, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Controlled cutover and bounded cancellation.
-- ---------------------------------------------------------------------------

create or replace function public.cutover_user_review_schedule_to_fsrs(
  p_user_id uuid,
  p_expected_projections jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings public.user_fsrs_settings%rowtype;
  v_projection public.fsrs_review_schedule_projection%rowtype;
  v_schedule public.review_schedule%rowtype;
  v_snapshot jsonb;
  v_expected jsonb;
  v_cutover_id uuid;
  v_count integer := 0;
begin
  if jsonb_typeof(p_expected_projections) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_FSRS_CUTOVER_EXPECTATIONS';
  end if;

  select * into v_settings
  from public.user_fsrs_settings settings
  where settings.user_id = p_user_id
  for update;

  if not found or v_settings.authority_mode <> 'sm2' then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_NOT_AVAILABLE';
  end if;

  if exists (
    select 1
    from public.effective_problem_review_events event
    where event.user_id = p_user_id
      and event.event_kind = 'review'
      and not exists (
        select 1
        from public.fsrs_review_schedule_projection projection
        where projection.user_id = event.user_id
          and projection.problem_id = event.problem_id
          and projection.card_initialized
      )
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_PROJECTION_MISSING';
  end if;

  if exists (
    select 1
    from public.problem_review_projection_jobs job
    where job.user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_PROJECTION_DIRTY';
  end if;

  if jsonb_array_length(p_expected_projections) <> (
    select count(*)
    from public.fsrs_review_schedule_projection projection
    where projection.user_id = p_user_id
      and projection.card_initialized
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_EXPECTATION_MISMATCH';
  end if;

  insert into public.fsrs_authority_cutovers (user_id, problem_count)
  values (p_user_id, jsonb_array_length(p_expected_projections))
  returning id into v_cutover_id;

  for v_projection in
    select *
    from public.fsrs_review_schedule_projection projection
    where projection.user_id = p_user_id
      and projection.card_initialized
    order by projection.problem_id
    for update
  loop
    select value into v_expected
    from jsonb_array_elements(p_expected_projections)
    where value ->> 'problem_id' = v_projection.problem_id::text;

    v_snapshot := private.problem_review_timeline_snapshot(
      p_user_id,
      v_projection.problem_id
    );

    if v_expected is null
       or (v_expected ->> 'projection_revision')::bigint
          <> v_projection.projection_revision
       or (v_expected ->> 'timeline_fingerprint')
          <> v_projection.timeline_fingerprint
       or (v_snapshot ->> 'event_count')::integer
          <> v_projection.timeline_event_count
       or (v_snapshot ->> 'fingerprint')
          <> v_projection.timeline_fingerprint then
      raise exception using errcode = '55000', message = 'FSRS_CUTOVER_PROJECTION_STALE';
    end if;

    select * into v_schedule
    from public.review_schedule schedule
    where schedule.user_id = p_user_id
      and schedule.problem_id = v_projection.problem_id
    for update;

    insert into public.fsrs_authority_cutover_snapshots (
      cutover_id,
      user_id,
      problem_id,
      schedule_existed,
      previous_next_review_at,
      previous_interval_days,
      previous_ease_factor,
      previous_repetition_number,
      previous_last_reviewed_at,
      previous_authority_algorithm,
      previous_authority_projection_revision,
      previous_authority_parameter_set_id,
      fsrs_projection_revision,
      timeline_event_count,
      timeline_fingerprint
    ) values (
      v_cutover_id,
      p_user_id,
      v_projection.problem_id,
      found,
      v_schedule.next_review_at,
      v_schedule.interval_days,
      v_schedule.ease_factor,
      v_schedule.repetition_number,
      v_schedule.last_reviewed_at,
      v_schedule.authority_algorithm,
      v_schedule.authority_projection_revision,
      v_schedule.authority_parameter_set_id,
      v_projection.projection_revision,
      v_projection.timeline_event_count,
      v_projection.timeline_fingerprint
    );

    insert into public.review_schedule (
      user_id,
      problem_id,
      next_review_at,
      interval_days,
      ease_factor,
      repetition_number,
      last_reviewed_at,
      updated_at,
      authority_algorithm,
      authority_projection_revision,
      authority_parameter_set_id
    ) values (
      p_user_id,
      v_projection.problem_id,
      v_projection.next_review_at,
      1,
      2.5,
      0,
      v_projection.last_reviewed_at,
      clock_timestamp(),
      'fsrs',
      v_projection.projection_revision,
      v_projection.calculated_parameter_set_id
    ) on conflict (user_id, problem_id) do update
    set next_review_at = excluded.next_review_at,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at,
        authority_algorithm = excluded.authority_algorithm,
        authority_projection_revision = excluded.authority_projection_revision,
        authority_parameter_set_id = excluded.authority_parameter_set_id;

    v_count := v_count + 1;
  end loop;

  update public.user_fsrs_settings
  set authority_mode = 'fsrs',
      active_cutover_id = v_cutover_id,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  return jsonb_build_object(
    'cutover_id', v_cutover_id,
    'user_id', p_user_id,
    'authority_mode', 'fsrs',
    'problem_count', v_count
  );
end;
$$;

revoke all on function public.cutover_user_review_schedule_to_fsrs(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.cutover_user_review_schedule_to_fsrs(uuid, jsonb)
  to service_role;

create or replace function public.cancel_fsrs_authority_cutover(
  p_user_id uuid,
  p_cutover_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings public.user_fsrs_settings%rowtype;
  v_snapshot public.fsrs_authority_cutover_snapshots%rowtype;
  v_current jsonb;
  v_restored integer := 0;
begin
  select * into v_settings
  from public.user_fsrs_settings settings
  where settings.user_id = p_user_id
  for update;

  if not found
     or v_settings.authority_mode <> 'fsrs'
     or v_settings.active_cutover_id is distinct from p_cutover_id then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_NOT_ACTIVE';
  end if;

  for v_snapshot in
    select *
    from public.fsrs_authority_cutover_snapshots snapshot
    where snapshot.cutover_id = p_cutover_id
      and snapshot.user_id = p_user_id
    order by snapshot.problem_id
  loop
    v_current := private.problem_review_timeline_snapshot(
      p_user_id,
      v_snapshot.problem_id
    );

    if (v_current ->> 'event_count')::integer <> v_snapshot.timeline_event_count
       or v_current ->> 'fingerprint' <> v_snapshot.timeline_fingerprint then
      raise exception using
        errcode = '55000',
        message = 'FSRS_CUTOVER_HAS_NEW_REVIEWS';
    end if;
  end loop;

  for v_snapshot in
    select *
    from public.fsrs_authority_cutover_snapshots snapshot
    where snapshot.cutover_id = p_cutover_id
      and snapshot.user_id = p_user_id
    order by snapshot.problem_id
  loop
    if v_snapshot.schedule_existed then
      update public.review_schedule
      set next_review_at = v_snapshot.previous_next_review_at,
          interval_days = v_snapshot.previous_interval_days,
          ease_factor = v_snapshot.previous_ease_factor,
          repetition_number = v_snapshot.previous_repetition_number,
          last_reviewed_at = v_snapshot.previous_last_reviewed_at,
          authority_algorithm = coalesce(
            v_snapshot.previous_authority_algorithm,
            'sm2'
          ),
          authority_projection_revision =
            v_snapshot.previous_authority_projection_revision,
          authority_parameter_set_id =
            v_snapshot.previous_authority_parameter_set_id,
          updated_at = clock_timestamp()
      where user_id = p_user_id
        and problem_id = v_snapshot.problem_id;
    else
      delete from public.review_schedule
      where user_id = p_user_id
        and problem_id = v_snapshot.problem_id;
    end if;
    v_restored := v_restored + 1;
  end loop;

  update public.user_fsrs_settings
  set authority_mode = 'sm2',
      active_cutover_id = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  update public.fsrs_authority_cutovers
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where id = p_cutover_id
    and user_id = p_user_id
    and status = 'active';

  return jsonb_build_object(
    'cutover_id', p_cutover_id,
    'user_id', p_user_id,
    'authority_mode', 'sm2',
    'restored_problem_count', v_restored
  );
end;
$$;

revoke all on function public.cancel_fsrs_authority_cutover(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_fsrs_authority_cutover(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Owner-safe diagnostics read model. Raw runs/Applications stay hidden.
-- ---------------------------------------------------------------------------

create or replace function private.get_problem_review_scheduler_diagnostics(
  p_problem_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if not exists (
    select 1 from public.problems problem
    where problem.id = p_problem_id
      and problem.user_id = v_user_id
  ) then
    raise exception using errcode = '42501', message = 'PROBLEM_NOT_OWNED';
  end if;

  select jsonb_build_object(
    'version', 1,
    'problem_id', p_problem_id,
    'authority_mode', coalesce(settings.authority_mode, 'sm2'),
    'authority', jsonb_build_object(
      'algorithm', coalesce(schedule.authority_algorithm, 'sm2'),
      'next_review_at', schedule.next_review_at,
      'projection_revision', schedule.authority_projection_revision
    ),
    'fsrs', case
      when projection.user_id is null then null
      else jsonb_build_object(
        'algorithm_version', projection.scheduler_algorithm,
        'library_name', projection.library_name,
        'library_version', projection.library_version,
        'card_initialized', projection.card_initialized,
        'state', projection.fsrs_state,
        'stability', projection.stability,
        'difficulty', projection.difficulty,
        'scheduled_days', projection.scheduled_days,
        'reps', projection.reps,
        'lapses', projection.lapses,
        'next_review_at', projection.next_review_at,
        'projection_revision', projection.projection_revision,
        'parameter_stable_key', parameters.stable_key
      )
    end,
    'projection', jsonb_build_object(
      'status', coalesce(job.status, 'ready'),
      'dirty_from', job.dirty_from,
      'attempt_count', coalesce(job.attempt_count, 0),
      'last_error_code', job.last_error_code,
      'timeline_event_count', coalesce(projection.timeline_event_count, 0)
    ),
    'timeline', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'review_occurrence_id', event.review_occurrence_id,
          'event_id', event.id,
          'event_kind', event.event_kind,
          'human_rating', event.human_rating,
          'reviewed_at', event.reviewed_at,
          'effective_review_at', event.effective_review_at,
          'corrected', (
            select count(*) > 1
            from public.problem_review_events revision
            where revision.review_occurrence_id = event.review_occurrence_id
          )
        ) order by event.effective_review_at, event.received_at, event.id
      )
      from public.effective_problem_review_events event
      where event.user_id = v_user_id
        and event.problem_id = p_problem_id
    ), '[]'::jsonb)
  ) into v_result
  from (select 1) singleton
  left join public.user_fsrs_settings settings
    on settings.user_id = v_user_id
  left join public.review_schedule schedule
    on schedule.user_id = v_user_id
    and schedule.problem_id = p_problem_id
  left join public.fsrs_review_schedule_projection projection
    on projection.user_id = v_user_id
    and projection.problem_id = p_problem_id
  left join public.fsrs_parameter_sets parameters
    on parameters.id = projection.calculated_parameter_set_id
  left join public.problem_review_projection_jobs job
    on job.user_id = v_user_id
    and job.problem_id = p_problem_id;

  return v_result;
end;
$$;

revoke all on function private.get_problem_review_scheduler_diagnostics(uuid)
  from public, anon;
grant execute on function private.get_problem_review_scheduler_diagnostics(uuid)
  to authenticated, service_role;

create or replace function public.get_problem_review_scheduler_diagnostics(
  p_problem_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.get_problem_review_scheduler_diagnostics(p_problem_id);
$$;

revoke all on function public.get_problem_review_scheduler_diagnostics(uuid)
  from public, anon;
grant execute on function public.get_problem_review_scheduler_diagnostics(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Idempotent fact replay repairs scheduler provenance before projection.
-- ---------------------------------------------------------------------------

create or replace function private.repair_problem_review_scheduler_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.user_fsrs_settings%rowtype;
  v_anchor public.problem_review_events%rowtype;
  v_schedule public.review_schedule%rowtype;
  v_schedule_existed boolean := false;
  v_timezone text := 'UTC';
begin
  if new.status <> 'pending' then return new; end if;

  insert into public.user_fsrs_settings (
    user_id,
    active_parameter_set_id,
    authority_mode
  ) values (
    new.user_id,
    'f5000000-0000-4000-8000-000000000001'::uuid,
    'sm2'
  ) on conflict (user_id) do nothing;

  select * into strict v_settings
  from public.user_fsrs_settings settings
  where settings.user_id = new.user_id;

  insert into public.user_fsrs_parameter_activations (
    user_id,
    parameter_set_id,
    activation_source
  )
  select
    v_settings.user_id,
    v_settings.active_parameter_set_id,
    'baseline'
  where not exists (
    select 1
    from public.user_fsrs_parameter_activations activation
    where activation.user_id = v_settings.user_id
  );

  insert into public.problem_review_occurrence_parameter_assignments (
    review_occurrence_id,
    user_id,
    problem_id,
    parameter_set_id,
    assigned_at,
    assignment_source
  )
  select
    event.review_occurrence_id,
    event.user_id,
    event.problem_id,
    coalesce(
      (
        select activation.parameter_set_id
        from public.user_fsrs_parameter_activations activation
        where activation.user_id = event.user_id
          and activation.activated_at <= event.received_at
        order by activation.activated_at desc, activation.id desc
        limit 1
      ),
      (
        select activation.parameter_set_id
        from public.user_fsrs_parameter_activations activation
        where activation.user_id = event.user_id
        order by activation.activated_at, activation.id
        limit 1
      ),
      v_settings.active_parameter_set_id
    ),
    event.received_at,
    'fact'
  from public.effective_problem_review_events event
  where event.user_id = new.user_id
    and event.problem_id = new.problem_id
    and event.event_kind = 'review'
    and not exists (
      select 1
      from public.problem_review_occurrence_parameter_assignments assignment
      where assignment.review_occurrence_id = event.review_occurrence_id
    )
  on conflict (review_occurrence_id) do nothing;

  if v_settings.authority_mode = 'sm2'
     and not exists (
       select 1
       from public.problem_review_sm2_compatibility_baselines baseline
       where baseline.user_id = new.user_id
         and baseline.problem_id = new.problem_id
     ) then
    select * into v_anchor
    from public.effective_problem_review_events event
    where event.user_id = new.user_id
      and event.problem_id = new.problem_id
      and event.event_kind = 'review'
    order by event.effective_review_at, event.received_at, event.id
    limit 1;

    if found then
      select coalesce(nullif(btrim(profile.timezone), ''), 'UTC')
      into v_timezone
      from public.user_profiles profile
      where profile.id = new.user_id;
      v_timezone := coalesce(v_timezone, 'UTC');

      select exists (
        select 1
        from public.review_schedule schedule
        where schedule.user_id = new.user_id
          and schedule.problem_id = new.problem_id
      ) into v_schedule_existed;

      select * into v_schedule
      from public.review_schedule schedule
      where schedule.user_id = new.user_id
        and schedule.problem_id = new.problem_id;

      insert into public.problem_review_sm2_compatibility_baselines (
        user_id,
        problem_id,
        anchor_review_occurrence_id,
        captured_at,
        timezone,
        schedule_existed,
        repetition_number,
        ease_factor,
        interval_days,
        last_reviewed_at,
        next_review_at
      ) values (
        new.user_id,
        new.problem_id,
        v_anchor.review_occurrence_id,
        clock_timestamp(),
        v_timezone,
        v_schedule_existed,
        coalesce(v_schedule.repetition_number, 0),
        coalesce(v_schedule.ease_factor, 2.5),
        coalesce(v_schedule.interval_days, 1),
        v_schedule.last_reviewed_at,
        v_schedule.next_review_at
      ) on conflict (user_id, problem_id) do nothing;
    end if;
  end if;

  return new;
end;
$$;

create trigger repair_problem_review_scheduler_provenance
after insert or update of status on public.problem_review_projection_jobs
for each row
when (new.status = 'pending')
execute function private.repair_problem_review_scheduler_provenance();

revoke all on function private.repair_problem_review_scheduler_provenance()
  from public, anon, authenticated;
grant execute on function private.repair_problem_review_scheduler_provenance()
  to service_role;

-- ---------------------------------------------------------------------------
-- Legacy Problem Study v1 now writes human facts only. Both projections are
-- asynchronous derivatives of the same immutable Event stream.
-- ---------------------------------------------------------------------------

create or replace function public.record_problem_review_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_request_id text,
  p_problem_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.problem_review_observations%rowtype;
  v_problem public.problems%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_status text;
  v_result jsonb;
begin
  if p_user_id is null
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_problem_id is null
     or p_action not in ('correct', 'hesitant', 'wrong', 'skip')
     or p_occurred_at is null then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_REVIEW';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'problem-review:' || p_user_id::text || ':' ||
      coalesce(p_device_id::text, 'web') || ':' || p_request_id,
      0::bigint
    )
  );

  select * into v_existing
  from public.problem_review_observations observation
  where observation.user_id = p_user_id
    and observation.device_id is not distinct from p_device_id
    and observation.request_id = p_request_id;

  if found then
    if v_existing.problem_id <> p_problem_id
       or v_existing.action <> p_action
       or v_existing.occurred_at <> p_occurred_at then
      raise exception using errcode = '23505', message = 'REVIEW_REQUEST_ID_REUSED';
    end if;
    perform private.mark_problem_review_timeline_dirty(
      v_existing.user_id,
      v_existing.problem_id,
      least(v_existing.occurred_at, v_existing.created_at)
    );
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_problem
  from public.problems problem
  where problem.id = p_problem_id
    and problem.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'REVIEW_PROBLEM_NOT_VISIBLE';
  end if;

  if p_action <> 'skip' then
    v_status := case p_action
      when 'correct' then 'mastered'
      when 'hesitant' then 'needs_review'
      else 'wrong'
    end;
  end if;

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'problem_id', p_problem_id,
    'action', p_action,
    'status', coalesce(v_status, v_problem.status::text),
    'schedule', null,
    'projection_applied', false,
    'replayed', false
  );

  insert into public.problem_review_observations (
    id,
    user_id,
    device_id,
    request_id,
    problem_id,
    action,
    occurred_at,
    result
  ) values (
    v_observation_id,
    p_user_id,
    p_device_id,
    p_request_id,
    p_problem_id,
    p_action,
    p_occurred_at,
    v_result
  );

  return v_result;
end;
$$;

revoke all on function public.record_problem_review_v1(
  uuid, uuid, text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_problem_review_v1(
  uuid, uuid, text, uuid, text, timestamptz
) to service_role;
