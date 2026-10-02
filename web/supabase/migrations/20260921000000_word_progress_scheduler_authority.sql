-- Word progress scheduler authority: switchable SM-2 / FSRS
--
-- Before this migration the word scheduler lived entirely inside
-- record_study_observation_v1: a hardcoded SM-2 ladder (new -> 1d,
-- learning -> 3d, review -> interval*2 capped at 180, mastered at
-- streak>=5 && interval>=30) wrote word_progress synchronously. There was no
-- way to run FSRS for words and no shadow state to cut over to.
--
-- This migration gives the word side the same shape the problem side already
-- has, with one deliberate difference:
--
--   * word_progress stays the single authoritative schedule table;
--   * word_progress_fsrs_projection is the FSRS shadow, rebuilt by replaying
--     word_review_events from the beginning on every run;
--   * under authority_mode='sm2' the synchronous ladder in
--     record_study_observation_v1 is byte-for-byte the old behaviour, so a
--     deployment that never flips the switch behaves exactly as before;
--   * under authority_mode='fsrs' the same function stops writing the
--     schedule and only keeps the counters, marks the timeline dirty, and the
--     asynchronous projector writes status/due_at/interval_days/lapses.
--
-- Facts are unchanged either way: study_observations, word_review_events,
-- study_sessions.next_sequence and the word_mistake_links projection all keep
-- their current synchronous semantics, because word_review_events.wrong_problem_id
-- is a foreign key into problems and must be written in the same transaction
-- that creates the wrong-word problem.
--
-- authority_mode is per user (user_word_scheduler_settings). The deployment
-- environment variable WORD_REVIEW_ALGORITHM only supplies the default that
-- seed_word_scheduler_settings() writes for users that have no row yet, and
-- for 'fsrs' it only seeds users whose reviewed words are already fully
-- projected -- an environment flip can therefore never cut over onto a stale
-- shadow.

-- ---------------------------------------------------------------------------
-- 1. word_progress becomes an authority table with a switchable algorithm
-- ---------------------------------------------------------------------------

alter table public.word_progress
  add column if not exists authority_algorithm text not null default 'sm2',
  add column if not exists authority_projection_revision bigint;

-- FSRS schedules up to 365 days; the SM-2 ladder still caps at 180 in code.
alter table public.word_progress
  drop constraint if exists word_progress_interval_days_check;
alter table public.word_progress
  add constraint word_progress_interval_days_check
  check (interval_days between 0 and 365);

alter table public.word_progress
  drop constraint if exists word_progress_authority_algorithm_check;
alter table public.word_progress
  add constraint word_progress_authority_algorithm_check
  check (authority_algorithm in ('sm2', 'fsrs'));

alter table public.word_progress
  drop constraint if exists word_progress_authority_fields_check;
alter table public.word_progress
  add constraint word_progress_authority_fields_check
  check (
    (authority_algorithm = 'sm2' and authority_projection_revision is null)
    or (
      authority_algorithm = 'fsrs'
      and authority_projection_revision is not null
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Per-user scheduler settings
-- ---------------------------------------------------------------------------

create table if not exists public.user_word_scheduler_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  authority_mode text not null default 'sm2',
  active_cutover_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_word_scheduler_settings_authority_mode_check
    check (authority_mode in ('sm2', 'fsrs'))
);

-- ---------------------------------------------------------------------------
-- 3. FSRS shadow card
-- ---------------------------------------------------------------------------

create table if not exists public.word_progress_fsrs_projection (
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  card_initialized boolean not null,
  scheduler_algorithm text not null default 'FSRS-6.0',
  library_name text not null default 'ts-fsrs',
  library_version text not null default '5.4.1',
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
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, word_entry_id),
  constraint word_progress_fsrs_projection_revision_check
    check (projection_revision >= 0),
  constraint word_progress_fsrs_projection_count_check
    check (timeline_event_count >= 0),
  constraint word_progress_fsrs_projection_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint word_progress_fsrs_projection_card_check
    check (
      (
        card_initialized
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
      )
    )
);

create index if not exists word_progress_fsrs_projection_due_idx
  on public.word_progress_fsrs_projection (user_id, next_review_at)
  where card_initialized;

-- ---------------------------------------------------------------------------
-- 4. Dirty-timeline job queue
-- ---------------------------------------------------------------------------

create table if not exists public.word_progress_projection_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  dirty_from timestamptz not null,
  status text not null default 'pending',
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key (user_id, word_entry_id),
  constraint word_progress_projection_jobs_status_check
    check (status in ('pending', 'processing', 'retry')),
  constraint word_progress_projection_jobs_attempt_count_check
    check (attempt_count >= 0),
  constraint word_progress_projection_jobs_lease_check
    check (
      (status = 'processing' and lease_token is not null and lease_until is not null)
      or (status <> 'processing' and lease_token is null and lease_until is null)
    )
);

create index if not exists word_progress_projection_jobs_claim_idx
  on public.word_progress_projection_jobs (status, next_retry_at, updated_at);

-- ---------------------------------------------------------------------------
-- 5. Projection runs
-- ---------------------------------------------------------------------------

create table if not exists public.word_progress_projection_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  lease_token uuid not null,
  status text not null default 'processing',
  reason text not null default 'dirty_timeline',
  base_projection_revision bigint not null,
  timeline_event_count integer not null,
  timeline_fingerprint text not null,
  error_code text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint word_progress_projection_runs_status_check
    check (status in ('processing', 'committed', 'failed', 'stale')),
  constraint word_progress_projection_runs_reason_check
    check (reason in ('dirty_timeline', 'explicit')),
  constraint word_progress_projection_runs_revision_check
    check (base_projection_revision >= 0),
  constraint word_progress_projection_runs_count_check
    check (timeline_event_count >= 0),
  constraint word_progress_projection_runs_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint word_progress_projection_runs_terminal_check
    check (
      (status = 'processing' and completed_at is null and error_code is null)
      or (status = 'committed' and completed_at is not null and error_code is null)
      or (status in ('failed', 'stale') and completed_at is not null)
    )
);

create unique index if not exists word_progress_projection_runs_processing_lease_uidx
  on public.word_progress_projection_runs (user_id, word_entry_id, lease_token)
  where status = 'processing';
create index if not exists word_progress_projection_runs_timeline_idx
  on public.word_progress_projection_runs (user_id, word_entry_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 6. Cutover ledger and rollback snapshots
-- ---------------------------------------------------------------------------

create table if not exists public.word_progress_authority_cutovers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active',
  word_count integer not null,
  cutover_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz,
  constraint word_progress_authority_cutovers_status_check
    check (status in ('active', 'cancelled')),
  constraint word_progress_authority_cutovers_count_check
    check (word_count >= 0),
  constraint word_progress_authority_cutovers_cancel_check
    check (
      (status = 'active' and cancelled_at is null)
      or (status = 'cancelled' and cancelled_at is not null)
    )
);

create unique index if not exists word_progress_authority_cutovers_active_user_uidx
  on public.word_progress_authority_cutovers (user_id)
  where status = 'active';

alter table public.user_word_scheduler_settings
  drop constraint if exists user_word_scheduler_settings_active_cutover_fkey;
alter table public.user_word_scheduler_settings
  add constraint user_word_scheduler_settings_active_cutover_fkey
  foreign key (active_cutover_id)
  references public.word_progress_authority_cutovers(id)
  on delete set null;

create table if not exists public.word_progress_authority_cutover_snapshots (
  cutover_id uuid not null
    references public.word_progress_authority_cutovers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  progress_existed boolean not null,
  previous_status text,
  previous_due_at timestamptz,
  previous_last_reviewed_at timestamptz,
  previous_interval_days integer,
  previous_correct_streak integer,
  previous_lapses integer,
  previous_reviewed_count integer,
  previous_known_count integer,
  previous_unknown_count integer,
  previous_authority_algorithm text,
  previous_authority_projection_revision bigint,
  fsrs_projection_revision bigint not null,
  timeline_event_count integer not null,
  timeline_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (cutover_id, word_entry_id),
  constraint word_progress_authority_cutover_snapshots_hash_check
    check (timeline_fingerprint ~ '^[0-9a-f]{64}$')
);

create index if not exists word_progress_authority_cutover_snapshots_user_idx
  on public.word_progress_authority_cutover_snapshots (user_id, cutover_id);

-- ---------------------------------------------------------------------------
-- 7. Dirty marking
-- ---------------------------------------------------------------------------

create or replace function private.mark_word_progress_timeline_dirty(
  p_user_id uuid,
  p_word_entry_id uuid,
  p_dirty_from timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.word_progress_projection_jobs (
    user_id,
    word_entry_id,
    dirty_from,
    status,
    lease_token,
    lease_until,
    next_retry_at,
    last_error_code,
    updated_at
  ) values (
    p_user_id,
    p_word_entry_id,
    p_dirty_from,
    'pending',
    null,
    null,
    now(),
    null,
    now()
  )
  on conflict (user_id, word_entry_id) do update
  set dirty_from = least(
        public.word_progress_projection_jobs.dirty_from,
        excluded.dirty_from
      ),
      status = 'pending',
      lease_token = null,
      lease_until = null,
      -- A new fact restarts the retry budget: without this, a word that once
      -- exhausted its attempts would be abandoned again on its very next
      -- failure, because the dirty marking above only clears the lease.
      attempt_count = 0,
      next_retry_at = now(),
      last_error_code = null,
      updated_at = now();
$$;

revoke all on function private.mark_word_progress_timeline_dirty(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function private.mark_word_progress_timeline_dirty(uuid, uuid, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Timeline fingerprint
--
-- word_review_events has no supersession column: every row is a human verdict
-- that stays in force, so the view indirection the problem side needs is not
-- required here.
--
-- The scheduling timeline is the known/unknown subset. 'skip' is recorded as a
-- fact but never feeds either algorithm, and including it would make a skip
-- invalidate an in-flight projection run with nothing left to re-queue it.
-- ---------------------------------------------------------------------------

create or replace function private.word_progress_timeline_snapshot(
  p_user_id uuid,
  p_word_entry_id uuid
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
      event.outcome,
      event.created_at,
      event.sequence
    from public.word_review_events event
    where event.user_id = p_user_id
      and event.word_entry_id = p_word_entry_id
      -- 'skip' is a fact but never a scheduling input, so it must not move the
      -- fingerprint: a skip that invalidated an in-flight run would leave the
      -- projection stale with nothing left to re-queue it.
      and event.outcome in ('known', 'unknown')
  ), serialized as (
    select
      coalesce(
        string_agg(
          id::text || '|' ||
          outcome || '|' ||
          created_at::text || '|' ||
          coalesce(sequence::text, ''),
          E'\n'
          order by created_at, id
        ),
        ''
      ) as payload,
      count(*)::integer as event_count
    from timeline
  )
  select jsonb_build_object(
    'event_count', event_count,
    'fingerprint', encode(
      extensions.digest(convert_to(payload, 'UTF8'), 'sha256'),
      'hex'
    )
  )
  from serialized;
$$;

revoke all on function private.word_progress_timeline_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.word_progress_timeline_snapshot(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. Claim / prepare / fail / commit
-- ---------------------------------------------------------------------------

create or replace function public.claim_word_progress_projection_jobs(
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
    select job.user_id, job.word_entry_id
    from public.word_progress_projection_jobs job
    where (
      job.status in ('pending', 'retry')
      and job.next_retry_at <= clock_timestamp()
    ) or (
      job.status = 'processing'
      and job.lease_until <= clock_timestamp()
    )
    order by job.next_retry_at, job.updated_at, job.user_id, job.word_entry_id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.word_progress_projection_jobs job
    set status = 'processing',
        lease_token = gen_random_uuid(),
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = job.attempt_count + 1,
        updated_at = clock_timestamp()
    from candidates
    where job.user_id = candidates.user_id
      and job.word_entry_id = candidates.word_entry_id
    returning
      job.user_id,
      job.word_entry_id,
      job.dirty_from,
      job.lease_token,
      job.lease_until,
      job.attempt_count
  )
  select coalesce(
    jsonb_agg(to_jsonb(claimed) order by dirty_from, user_id, word_entry_id),
    '[]'::jsonb
  ) into v_result
  from claimed;

  return v_result;
end;
$$;

revoke all on function public.claim_word_progress_projection_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_word_progress_projection_jobs(integer, integer)
  to service_role;

create or replace function public.prepare_word_progress_projection(
  p_user_id uuid,
  p_word_entry_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.word_progress_projection_jobs%rowtype;
  v_snapshot jsonb;
  v_projection public.word_progress_fsrs_projection%rowtype;
  v_settings public.user_word_scheduler_settings%rowtype;
  v_run public.word_progress_projection_runs%rowtype;
  v_events jsonb;
begin
  select * into v_job
  from public.word_progress_projection_jobs job
  where job.user_id = p_user_id
    and job.word_entry_id = p_word_entry_id
  for update;

  if not found
     or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'PROJECTION_LEASE_LOST';
  end if;

  select * into v_settings
  from public.user_word_scheduler_settings settings
  where settings.user_id = p_user_id;

  select * into v_projection
  from public.word_progress_fsrs_projection projection
  where projection.user_id = p_user_id
    and projection.word_entry_id = p_word_entry_id;

  v_snapshot := private.word_progress_timeline_snapshot(p_user_id, p_word_entry_id);

  select * into v_run
  from public.word_progress_projection_runs run
  where run.user_id = p_user_id
    and run.word_entry_id = p_word_entry_id
    and run.lease_token = p_lease_token
    and run.status = 'processing';

  if not found then
    insert into public.word_progress_projection_runs (
      user_id,
      word_entry_id,
      lease_token,
      base_projection_revision,
      timeline_event_count,
      timeline_fingerprint
    ) values (
      p_user_id,
      p_word_entry_id,
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
        'outcome', event.outcome,
        'occurred_at', event.created_at,
        'sequence', event.sequence
      )
      order by event.created_at, event.id
    ),
    '[]'::jsonb
  ) into v_events
  from public.word_review_events event
  where event.user_id = p_user_id
    and event.word_entry_id = p_word_entry_id
    and event.outcome in ('known', 'unknown');

  return jsonb_build_object(
    'run_id', v_run.id,
    'user_id', p_user_id,
    'word_entry_id', p_word_entry_id,
    'lease_token', p_lease_token,
    'authority_mode', coalesce(v_settings.authority_mode, 'sm2'),
    'base_projection_revision', v_run.base_projection_revision,
    'timeline_event_count', v_run.timeline_event_count,
    'timeline_fingerprint', v_run.timeline_fingerprint,
    'events', v_events
  );
end;
$$;

revoke all on function public.prepare_word_progress_projection(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_word_progress_projection(uuid, uuid, uuid)
  to service_role;

create or replace function public.fail_word_progress_projection_job(
  p_user_id uuid,
  p_word_entry_id uuid,
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
    'INVALID_FSRS_CARD',
    'FSRS_CALCULATION_FAILED',
    'COMMIT_FAILED',
    'UNKNOWN'
  ) then
    p_error_code := 'UNKNOWN';
  end if;

  select job.attempt_count into v_attempt_count
  from public.word_progress_projection_jobs job
  where job.user_id = p_user_id
    and job.word_entry_id = p_word_entry_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
  for update;

  if not found then return false; end if;

  update public.word_progress_projection_runs run
  set status = 'failed',
      error_code = p_error_code,
      completed_at = clock_timestamp()
  where run.user_id = p_user_id
    and run.word_entry_id = p_word_entry_id
    and run.lease_token = p_lease_token
    and run.status = 'processing';

  -- Retrying forever is worse than it looks: under fsrs authority the
  -- synchronous path no longer writes status/due_at/interval_days, so a word
  -- whose replay never succeeds keeps its pre-failure due date (or none at
  -- all) for as long as the job sits there. After 8 attempts the job stops
  -- being claimable but stays in the table, so the health check can surface it
  -- and an operator can requeue it. A new fact resets attempt_count, so an old
  -- failure can never permanently brick the word.
  update public.word_progress_projection_jobs job
  set status = 'retry',
      lease_token = null,
      lease_until = null,
      next_retry_at = case
        when v_attempt_count >= 8 then 'infinity'::timestamptz
        else clock_timestamp() + make_interval(
          secs => least(3600, (15 * power(2, least(v_attempt_count, 8)))::integer)
        )
      end,
      last_error_code = p_error_code,
      updated_at = clock_timestamp()
  where job.user_id = p_user_id
    and job.word_entry_id = p_word_entry_id;

  return true;
end;
$$;

revoke all on function public.fail_word_progress_projection_job(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_word_progress_projection_job(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.commit_word_progress_projection(
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_event_count integer,
  p_expected_fingerprint text,
  p_expected_base_revision bigint,
  p_fsrs_card jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.word_progress_projection_runs%rowtype;
  v_job public.word_progress_projection_jobs%rowtype;
  v_projection public.word_progress_fsrs_projection%rowtype;
  v_snapshot jsonb;
  v_authority_mode text;
  v_review_count integer;
  v_target_revision bigint;
  v_card_initialized boolean;
  v_last_event_id uuid;
  v_status text;
  v_scheduled_days integer;
begin
  select * into v_run
  from public.word_progress_projection_runs run
  where run.id = p_run_id
  for update;

  if not found or v_run.status <> 'processing'
     or v_run.lease_token is distinct from p_lease_token then
    raise exception using errcode = '55000', message = 'PROJECTION_RUN_LOST';
  end if;

  select * into v_job
  from public.word_progress_projection_jobs job
  where job.user_id = v_run.user_id
    and job.word_entry_id = v_run.word_entry_id
  for update;

  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'PROJECTION_LEASE_LOST';
  end if;

  select * into v_projection
  from public.word_progress_fsrs_projection projection
  where projection.user_id = v_run.user_id
    and projection.word_entry_id = v_run.word_entry_id
  for update;

  v_snapshot := private.word_progress_timeline_snapshot(
    v_run.user_id,
    v_run.word_entry_id
  );

  if p_expected_event_count <> (v_snapshot ->> 'event_count')::integer
     or p_expected_fingerprint <> v_snapshot ->> 'fingerprint'
     or p_expected_event_count <> v_run.timeline_event_count
     or p_expected_fingerprint <> v_run.timeline_fingerprint
     or p_expected_base_revision <> v_run.base_projection_revision
     or p_expected_base_revision <> coalesce(v_projection.projection_revision, 0) then
    update public.word_progress_projection_runs
    set status = 'stale',
        error_code = 'TIMELINE_CHANGED',
        completed_at = clock_timestamp()
    where id = p_run_id;

    update public.word_progress_projection_jobs
    set status = 'pending',
        lease_token = null,
        lease_until = null,
        next_retry_at = clock_timestamp(),
        last_error_code = null,
        updated_at = clock_timestamp()
    where user_id = v_run.user_id
      and word_entry_id = v_run.word_entry_id;

    return jsonb_build_object('committed', false, 'stale', true);
  end if;

  -- The snapshot only contains known/unknown events, so its event count is
  -- the review count.
  v_review_count := (v_snapshot ->> 'event_count')::integer;
  v_target_revision := p_expected_base_revision + 1;
  v_card_initialized := p_fsrs_card is not null;

  if v_review_count = 0 and p_fsrs_card is not null then
    raise exception using errcode = '22023', message = 'PROJECTION_CARD_WITHOUT_REVIEW';
  elsif v_review_count > 0 and (
    p_fsrs_card is null or jsonb_typeof(p_fsrs_card) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'PROJECTION_CARD_MISSING';
  end if;

  select event.id into v_last_event_id
  from public.word_review_events event
  where event.user_id = v_run.user_id
    and event.word_entry_id = v_run.word_entry_id
    and event.outcome in ('known', 'unknown')
  order by event.created_at desc, event.id desc
  limit 1;

  insert into public.word_progress_fsrs_projection (
    user_id,
    word_entry_id,
    card_initialized,
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
    updated_at
  ) values (
    v_run.user_id,
    v_run.word_entry_id,
    v_card_initialized,
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
    clock_timestamp()
  ) on conflict (user_id, word_entry_id) do update
  set card_initialized = excluded.card_initialized,
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
      updated_at = excluded.updated_at;

  select settings.authority_mode into v_authority_mode
  from public.user_word_scheduler_settings settings
  where settings.user_id = v_run.user_id
  for update;
  v_authority_mode := coalesce(v_authority_mode, 'sm2');

  -- Only the FSRS authority writes the schedule. Under 'sm2' the synchronous
  -- ladder inside record_study_observation_v1 owns word_progress, and this
  -- commit must not race with it.
  if v_authority_mode = 'fsrs' and v_card_initialized then
    v_scheduled_days := (p_fsrs_card ->> 'scheduled_days')::integer;
    v_status := case p_fsrs_card ->> 'state'
      when 'New' then 'new'
      when 'Learning' then 'learning'
      when 'Relearning' then 'learning'
      else 'review'
    end;
    -- FSRS has no correct_streak to test, and it does not need one: a card
    -- scheduled 30 days out has already been recalled successfully several
    -- times, so this is the FSRS equivalent of the SM-2 ladder's
    -- "streak >= 5 and interval >= 30" promotion, not a copy of it.
    if v_scheduled_days >= 30 then
      v_status := 'mastered';
    end if;

    update public.word_progress progress
    set status = v_status,
        due_at = (p_fsrs_card ->> 'due')::timestamptz,
        interval_days = least(v_scheduled_days, 365),
        lapses = (p_fsrs_card ->> 'lapses')::integer,
        authority_algorithm = 'fsrs',
        authority_projection_revision = v_target_revision,
        updated_at = clock_timestamp()
    where progress.user_id = v_run.user_id
      and progress.word_entry_id = v_run.word_entry_id;

    if v_status = 'mastered' then
      update public.problems problem
      set status = 'mastered',
          last_reviewed_date = (p_fsrs_card ->> 'last_review')::timestamptz,
          updated_at = clock_timestamp()
      from public.word_mistake_links link
      where link.user_id = v_run.user_id
        and link.word_entry_id = v_run.word_entry_id
        and problem.id = link.problem_id
        and problem.user_id = v_run.user_id;
    end if;
  end if;

  update public.word_progress_projection_runs
  set status = 'committed',
      completed_at = clock_timestamp()
  where id = p_run_id;

  delete from public.word_progress_projection_jobs
  where user_id = v_run.user_id
    and word_entry_id = v_run.word_entry_id
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

revoke all on function public.commit_word_progress_projection(
  uuid, uuid, integer, text, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_word_progress_projection(
  uuid, uuid, integer, text, bigint, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Environment default seeding
--
-- WORD_REVIEW_ALGORITHM supplies p_default_authority_mode. The function only
-- creates rows for users that do not have one yet, and for 'fsrs' it only
-- seeds users whose reviewed words are all already projected, so flipping the
-- environment variable can never promote a stale or missing shadow.
-- ---------------------------------------------------------------------------

create or replace function public.seed_word_scheduler_settings(
  p_default_authority_mode text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer := 0;
begin
  if p_default_authority_mode not in ('sm2', 'fsrs') then
    raise exception using errcode = '22023', message = 'INVALID_WORD_SCHEDULER_DEFAULT';
  end if;

  -- The cron calls this every few minutes. Once every user has a row the
  -- insert below matches nothing, so pay for one short-circuited existence
  -- probe instead of a distinct scan over the whole progress table plus a
  -- per-user NOT EXISTS.
  if not exists (
    select 1
    from public.word_progress progress
    where not exists (
      select 1
      from public.user_word_scheduler_settings settings
      where settings.user_id = progress.user_id
    )
  ) then
    return jsonb_build_object('inserted', 0, 'authority_mode', p_default_authority_mode);
  end if;

  insert into public.user_word_scheduler_settings (user_id, authority_mode)
  select distinct progress.user_id, p_default_authority_mode
  from public.word_progress progress
  where not exists (
      select 1
      from public.user_word_scheduler_settings settings
      where settings.user_id = progress.user_id
    )
    and (
      p_default_authority_mode = 'sm2'
      or not exists (
        select 1
        from public.word_review_events event
        where event.user_id = progress.user_id
          and event.outcome in ('known', 'unknown')
          and not exists (
            select 1
            from public.word_progress_fsrs_projection projection
            where projection.user_id = event.user_id
              and projection.word_entry_id = event.word_entry_id
              and projection.card_initialized
          )
      )
    )
  order by progress.user_id
  limit 500
  on conflict (user_id) do nothing;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'inserted', v_inserted,
    'authority_mode', p_default_authority_mode
  );
end;
$$;

revoke all on function public.seed_word_scheduler_settings(text)
  from public, anon, authenticated;
grant execute on function public.seed_word_scheduler_settings(text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 11. Cutover and bounded cancellation
-- ---------------------------------------------------------------------------

create or replace function public.cutover_user_word_progress_to_fsrs(
  p_user_id uuid,
  p_expected_projections jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings public.user_word_scheduler_settings%rowtype;
  v_projection public.word_progress_fsrs_projection%rowtype;
  v_progress public.word_progress%rowtype;
  v_snapshot jsonb;
  v_expected jsonb;
  v_cutover_id uuid;
  v_count integer := 0;
begin
  if jsonb_typeof(p_expected_projections) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_FSRS_CUTOVER_EXPECTATIONS';
  end if;

  select * into v_settings
  from public.user_word_scheduler_settings settings
  where settings.user_id = p_user_id
  for update;

  if not found then
    insert into public.user_word_scheduler_settings (user_id, authority_mode)
    values (p_user_id, 'sm2')
    returning * into v_settings;
  end if;

  if v_settings.authority_mode <> 'sm2' then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_NOT_AVAILABLE';
  end if;

  if exists (
    select 1
    from public.word_review_events event
    where event.user_id = p_user_id
      and event.outcome in ('known', 'unknown')
      and not exists (
        select 1
        from public.word_progress_fsrs_projection projection
        where projection.user_id = event.user_id
          and projection.word_entry_id = event.word_entry_id
          and projection.card_initialized
      )
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_PROJECTION_MISSING';
  end if;

  if exists (
    select 1
    from public.word_progress_projection_jobs job
    where job.user_id = p_user_id
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_PROJECTION_DIRTY';
  end if;

  if jsonb_array_length(p_expected_projections) <> (
    select count(*)
    from public.word_progress_fsrs_projection projection
    where projection.user_id = p_user_id
      and projection.card_initialized
  ) then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_EXPECTATION_MISMATCH';
  end if;

  insert into public.word_progress_authority_cutovers (user_id, word_count)
  values (p_user_id, jsonb_array_length(p_expected_projections))
  returning id into v_cutover_id;

  for v_projection in
    select *
    from public.word_progress_fsrs_projection projection
    where projection.user_id = p_user_id
      and projection.card_initialized
    order by projection.word_entry_id
    for update
  loop
    select value into v_expected
    from jsonb_array_elements(p_expected_projections)
    where value ->> 'word_entry_id' = v_projection.word_entry_id::text;

    v_snapshot := private.word_progress_timeline_snapshot(
      p_user_id,
      v_projection.word_entry_id
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

    select * into v_progress
    from public.word_progress progress
    where progress.user_id = p_user_id
      and progress.word_entry_id = v_projection.word_entry_id
    for update;

    insert into public.word_progress_authority_cutover_snapshots (
      cutover_id,
      user_id,
      word_entry_id,
      progress_existed,
      previous_status,
      previous_due_at,
      previous_last_reviewed_at,
      previous_interval_days,
      previous_correct_streak,
      previous_lapses,
      previous_reviewed_count,
      previous_known_count,
      previous_unknown_count,
      previous_authority_algorithm,
      previous_authority_projection_revision,
      fsrs_projection_revision,
      timeline_event_count,
      timeline_fingerprint
    ) values (
      v_cutover_id,
      p_user_id,
      v_projection.word_entry_id,
      found,
      v_progress.status,
      v_progress.due_at,
      v_progress.last_reviewed_at,
      v_progress.interval_days,
      v_progress.correct_streak,
      v_progress.lapses,
      v_progress.reviewed_count,
      v_progress.known_count,
      v_progress.unknown_count,
      v_progress.authority_algorithm,
      v_progress.authority_projection_revision,
      v_projection.projection_revision,
      v_projection.timeline_event_count,
      v_projection.timeline_fingerprint
    );

    update public.word_progress progress
    set status = case
          when v_projection.scheduled_days >= 30 then 'mastered'
          when v_projection.fsrs_state in ('New') then 'new'
          when v_projection.fsrs_state in ('Learning', 'Relearning') then 'learning'
          else 'review'
        end,
        due_at = v_projection.next_review_at,
        interval_days = least(v_projection.scheduled_days, 365),
        lapses = v_projection.lapses,
        authority_algorithm = 'fsrs',
        authority_projection_revision = v_projection.projection_revision,
        updated_at = clock_timestamp()
    where progress.user_id = p_user_id
      and progress.word_entry_id = v_projection.word_entry_id;

    v_count := v_count + 1;
  end loop;

  update public.user_word_scheduler_settings
  set authority_mode = 'fsrs',
      active_cutover_id = v_cutover_id,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  return jsonb_build_object(
    'cutover_id', v_cutover_id,
    'user_id', p_user_id,
    'authority_mode', 'fsrs',
    'word_count', v_count
  );
end;
$$;

revoke all on function public.cutover_user_word_progress_to_fsrs(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.cutover_user_word_progress_to_fsrs(uuid, jsonb)
  to service_role;

create or replace function public.cancel_word_progress_fsrs_cutover(
  p_user_id uuid,
  p_cutover_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings public.user_word_scheduler_settings%rowtype;
  v_snapshot public.word_progress_authority_cutover_snapshots%rowtype;
  v_current jsonb;
  v_restored integer := 0;
begin
  select * into v_settings
  from public.user_word_scheduler_settings settings
  where settings.user_id = p_user_id
  for update;

  if not found
     or v_settings.authority_mode <> 'fsrs'
     or v_settings.active_cutover_id is distinct from p_cutover_id then
    raise exception using errcode = '55000', message = 'FSRS_CUTOVER_NOT_ACTIVE';
  end if;

  for v_snapshot in
    select *
    from public.word_progress_authority_cutover_snapshots snapshot
    where snapshot.cutover_id = p_cutover_id
      and snapshot.user_id = p_user_id
    order by snapshot.word_entry_id
  loop
    v_current := private.word_progress_timeline_snapshot(
      p_user_id,
      v_snapshot.word_entry_id
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
    from public.word_progress_authority_cutover_snapshots snapshot
    where snapshot.cutover_id = p_cutover_id
      and snapshot.user_id = p_user_id
    order by snapshot.word_entry_id
  loop
    if v_snapshot.progress_existed then
      update public.word_progress
      set status = v_snapshot.previous_status,
          due_at = v_snapshot.previous_due_at,
          last_reviewed_at = v_snapshot.previous_last_reviewed_at,
          interval_days = v_snapshot.previous_interval_days,
          correct_streak = v_snapshot.previous_correct_streak,
          lapses = v_snapshot.previous_lapses,
          reviewed_count = v_snapshot.previous_reviewed_count,
          known_count = v_snapshot.previous_known_count,
          unknown_count = v_snapshot.previous_unknown_count,
          authority_algorithm = coalesce(
            v_snapshot.previous_authority_algorithm,
            'sm2'
          ),
          authority_projection_revision =
            v_snapshot.previous_authority_projection_revision,
          updated_at = clock_timestamp()
      where user_id = p_user_id
        and word_entry_id = v_snapshot.word_entry_id;
      -- Only a snapshot with a row behind it can restore anything. Counting
      -- the rest would make the operator-facing count claim a rollback that
      -- never happened.
      v_restored := v_restored + 1;
    end if;
  end loop;

  update public.user_word_scheduler_settings
  set authority_mode = 'sm2',
      active_cutover_id = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  update public.word_progress_authority_cutovers
  set status = 'cancelled',
      cancelled_at = clock_timestamp()
  where id = p_cutover_id
    and user_id = p_user_id
    and status = 'active';

  return jsonb_build_object(
    'cutover_id', p_cutover_id,
    'user_id', p_user_id,
    'authority_mode', 'sm2',
    'restored_word_count', v_restored
  );
end;
$$;

revoke all on function public.cancel_word_progress_fsrs_cutover(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_word_progress_fsrs_cutover(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 12. RLS and least privilege
-- ---------------------------------------------------------------------------

alter table public.user_word_scheduler_settings enable row level security;
alter table public.word_progress_fsrs_projection enable row level security;
alter table public.word_progress_projection_jobs enable row level security;
alter table public.word_progress_projection_runs enable row level security;
alter table public.word_progress_authority_cutovers enable row level security;
alter table public.word_progress_authority_cutover_snapshots enable row level security;

revoke all on table public.user_word_scheduler_settings
  from public, anon, authenticated;
revoke all on table public.word_progress_fsrs_projection
  from public, anon, authenticated;
revoke all on table public.word_progress_projection_jobs
  from public, anon, authenticated;
revoke all on table public.word_progress_projection_runs
  from public, anon, authenticated;
revoke all on table public.word_progress_authority_cutovers
  from public, anon, authenticated;
revoke all on table public.word_progress_authority_cutover_snapshots
  from public, anon, authenticated;

grant all on table public.user_word_scheduler_settings to service_role;
grant all on table public.word_progress_fsrs_projection to service_role;
grant all on table public.word_progress_projection_jobs to service_role;
grant all on table public.word_progress_projection_runs to service_role;
grant all on table public.word_progress_authority_cutovers to service_role;
grant all on table public.word_progress_authority_cutover_snapshots to service_role;

-- Guarded so the whole file can be replayed: a partially applied migration is
-- the normal recovery path, and PostgreSQL has no CREATE TRIGGER IF NOT EXISTS.
drop trigger if exists prevent_word_progress_cutover_snapshot_update
  on public.word_progress_authority_cutover_snapshots;
create trigger prevent_word_progress_cutover_snapshot_update
before update on public.word_progress_authority_cutover_snapshots
for each row execute function private.prevent_fsrs_immutable_update();

-- ---------------------------------------------------------------------------
-- 13. Cold start: every existing word_progress row needs a shadow before a
--     cutover can be considered. Jobs are just rows; the projector drains them
--     at its own pace, and a deployment that never enables the word projector
--     simply leaves them queued.
-- ---------------------------------------------------------------------------

insert into public.word_progress_projection_jobs (
  user_id,
  word_entry_id,
  dirty_from,
  status,
  next_retry_at,
  updated_at
)
select
  progress.user_id,
  progress.word_entry_id,
  coalesce(progress.last_reviewed_at, progress.created_at),
  'pending',
  now(),
  now()
from public.word_progress progress
on conflict (user_id, word_entry_id) do nothing;

-- ---------------------------------------------------------------------------
-- 14. record_study_observation_v1: facts stay synchronous, the schedule
--     becomes mode dependent.
--
--     Body is 20260908000000_study_observation_abandoned_gap_terminal.sql with
--     exactly two changes:
--       * the SM-2 ladder only runs under authority_mode='sm2' (byte-for-byte
--         the old behaviour, so an sm2 deployment is unchanged);
--       * under 'fsrs' the function keeps the counters and marks the timeline
--         dirty instead of writing status/due_at/interval_days/lapses;
--       * every known/unknown observation marks the timeline dirty in both
--         modes, because the shadow must be current before a cutover.
-- ---------------------------------------------------------------------------

create or replace function public.record_study_observation_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_request_id text,
  p_session_id uuid,
  p_sequence bigint,
  p_item_id uuid,
  p_action text,
  p_mode text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_session public.study_sessions%rowtype;
  v_entry public.word_entries%rowtype;
  v_progress public.word_progress%rowtype;
  v_existing public.study_observations%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_progress_json jsonb := 'null'::jsonb;
  v_result jsonb;
  v_effective_at timestamptz;
  v_correct_streak integer;
  v_interval_days integer;
  v_next_status text;
  v_due_at timestamptz;
  v_subject_id uuid;
  v_problem_set_id uuid;
  v_problem_id uuid;
  v_wrong_problem_id uuid;
  v_legacy_outcome text;
  v_projection_applied boolean := false;
  v_authority_mode text;
begin
  if p_user_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null or p_item_id is null
     or p_sequence < 0 or p_sequence > 9007199254740991
     or p_action not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
     or p_mode not in ('sequential', 'random', 'dictionary')
     or p_occurred_at is null then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;

  -- Serialize identical request IDs before touching session or progress state.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || coalesce(p_device_id::text, 'web') || ':' || p_request_id,
      0::bigint
    )
  );

  select * into v_existing
  from public.study_observations o
  where o.user_id = p_user_id
    and o.device_id is not distinct from p_device_id
    and o.request_id = p_request_id;

  if found then
    if v_existing.session_id <> p_session_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.sequence <> p_sequence
       or v_existing.item_id <> p_item_id
       or v_existing.action <> p_action
       or v_existing.mode <> p_mode
       or v_existing.occurred_at <> p_occurred_at then
      raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id and s.user_id = p_user_id
    and s.expires_at > now()
  for update;

  -- A newly created session retires the previous one as `abandoned`, but
  -- already-durable offline observations from that session must still drain.
  -- Candidate snapshots are retained for this reconciliation window.
  if not found or v_session.domain <> 'word' or v_session.status not in ('active', 'paused', 'abandoned') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id or v_session.mode <> p_mode then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    -- A retired session can never receive the missing lower sequence: the
    -- replacement session already owns the device, and the outbox is FIFO, so
    -- nothing earlier is still in flight. Answering STUDY_SEQUENCE_GAP here
    -- would make the device retry this record forever and wedge the whole
    -- queue; closing the session lets it quarantine and drain instead.
    if v_session.status = 'abandoned' then
      raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
    end if;
    -- A missing earlier observation is recoverable: the device must keep this
    -- head pending until the lower sequence arrives.
    raise exception using errcode = 'P0001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    -- A request with an already-consumed sequence and a new request_id cannot
    -- be made idempotent safely; the device quarantines only this observation.
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

  select e.* into v_entry
  from public.word_entries e
  join public.word_decks d on d.id = e.deck_id
  where e.id = p_item_id
    and d.is_active = true
    and d.archived_at is null
    and (d.is_system = true or d.user_id = p_user_id)
    and (
      jsonb_array_length(v_session.scope -> 'deck_ids') = 0
      or exists (
        select 1
        from jsonb_array_elements_text(v_session.scope -> 'deck_ids') scoped(deck_id)
        where scoped.deck_id::uuid = e.deck_id
      )
    );

  if not found then
    raise exception using errcode = '22023', message = 'STUDY_ITEM_NOT_VISIBLE';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_session.candidate_items) item
    where (item ->> 'item_id')::uuid = p_item_id
  ) then
    raise exception using errcode = '22023', message = 'STUDY_ITEM_NOT_IN_SESSION';
  end if;

  v_effective_at := least(
    now(),
    greatest(p_occurred_at, timestamptz '2000-01-01 00:00:00+00')
  );

  select settings.authority_mode into v_authority_mode
  from public.user_word_scheduler_settings settings
  where settings.user_id = p_user_id;
  v_authority_mode := coalesce(v_authority_mode, 'sm2');

  if p_action in ('known', 'unknown') then
    insert into public.word_progress (user_id, word_entry_id)
    values (p_user_id, p_item_id)
    on conflict (user_id, word_entry_id) do nothing;

    select * into v_progress
    from public.word_progress p
    where p.user_id = p_user_id and p.word_entry_id = p_item_id
    for update;

    if v_progress.last_reviewed_at is null
       or v_effective_at > v_progress.last_reviewed_at then
      v_projection_applied := true;
    end if;

    if v_projection_applied and p_action = 'unknown' and v_authority_mode = 'sm2' then
      update public.word_progress
      set status = 'learning',
          due_at = v_effective_at,
          last_reviewed_at = v_effective_at,
          interval_days = 0,
          correct_streak = 0,
          lapses = v_progress.lapses + 1,
          reviewed_count = v_progress.reviewed_count + 1,
          unknown_count = v_progress.unknown_count + 1,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    elsif v_projection_applied and p_action = 'known' and v_authority_mode = 'sm2' then
      v_correct_streak := v_progress.correct_streak + 1;
      v_interval_days := v_progress.interval_days;
      v_next_status := v_progress.status;

      if v_progress.status = 'new' then
        v_next_status := 'learning';
        v_interval_days := 1;
      elsif v_progress.status = 'learning' then
        if v_correct_streak >= 2 then
          v_next_status := 'review';
          v_interval_days := 3;
        else
          v_interval_days := 1;
        end if;
      else
        v_next_status := case when v_progress.status = 'mastered' then 'mastered' else 'review' end;
        v_interval_days := least(greatest(v_progress.interval_days * 2, 3), 180);
      end if;

      if v_correct_streak >= 5 and v_interval_days >= 30 then
        v_next_status := 'mastered';
      end if;
      v_due_at := v_effective_at + make_interval(days => v_interval_days);

      update public.word_progress
      set status = v_next_status,
          due_at = v_due_at,
          last_reviewed_at = v_effective_at,
          interval_days = v_interval_days,
          correct_streak = v_correct_streak,
          reviewed_count = v_progress.reviewed_count + 1,
          known_count = v_progress.known_count + 1,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    elsif v_projection_applied then
      -- FSRS authority: the counters stay synchronous so the word lists keep
      -- showing live numbers, while status/due_at/interval_days/lapses are
      -- written by the projector from the FSRS card.
      update public.word_progress
      set last_reviewed_at = v_effective_at,
          reviewed_count = v_progress.reviewed_count + 1,
          known_count = v_progress.known_count
            + case when p_action = 'known' then 1 else 0 end,
          unknown_count = v_progress.unknown_count
            + case when p_action = 'unknown' then 1 else 0 end,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    end if;

    -- The shadow tracks every fact in both modes: it has to be current before
    -- a cutover can promote it, and a stale event still changes the timeline
    -- fingerprint the projector validates against.
    perform private.mark_word_progress_timeline_dirty(
      p_user_id,
      p_item_id,
      v_effective_at
    );
  else
    select * into v_progress
    from public.word_progress p
    where p.user_id = p_user_id and p.word_entry_id = p_item_id;
  end if;

  if v_progress.id is not null then
    v_progress_json := jsonb_build_object(
      'status', v_progress.status,
      'due_at', v_progress.due_at,
      'reviewed_count', v_progress.reviewed_count,
      'known_count', v_progress.known_count,
      'unknown_count', v_progress.unknown_count
    );
  end if;

  -- Wrong-word rows are a projection of canonical observations. Unknown
  -- creates/reopens the projection; mastery archives it without deleting
  -- history or the link.
  if v_projection_applied and p_action = 'unknown' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'word-mistakes:' || p_user_id::text || ':' || p_item_id::text,
        0::bigint
      )
    );

    select l.problem_set_id, l.problem_id
      into v_problem_set_id, v_problem_id
      from public.word_mistake_links l
      where l.user_id = p_user_id and l.word_entry_id = p_item_id;

    if v_problem_id is not null then
      update public.problems
      set status = 'wrong',
          last_reviewed_date = v_effective_at,
          updated_at = now()
      where id = v_problem_id and user_id = p_user_id;
    else
      select s.id into v_subject_id
      from public.subjects s
      where s.user_id = p_user_id
        and s.name in ('英语', 'English', 'English Vocabulary')
      order by case s.name when '英语' then 0 when 'English' then 1 else 2 end
      limit 1;

      if v_subject_id is null then
        insert into public.subjects (user_id, name, color, icon)
        values (p_user_id, '英语', 'blue', 'BookOpen')
        returning id into v_subject_id;
      end if;

      select ps.id into v_problem_set_id
      from public.problem_sets ps
      where ps.user_id = p_user_id and ps.type = 'word_mistakes'
      limit 1;

      if v_problem_set_id is null then
        insert into public.problem_sets (
          user_id, subject_id, name, description, sharing_level,
          is_smart, allow_copying, is_listed, type
        ) values (
          p_user_id, v_subject_id, '遗忘的单词',
          '由单词学习记录自动维护。', 'private', false, false, false,
          'word_mistakes'
        ) returning id into v_problem_set_id;
      end if;

      insert into public.problems (
        user_id, subject_id, title, content, assets,
        solution_text, solution_assets, parts, status,
        last_reviewed_date
      ) values (
        p_user_id,
        v_subject_id,
        v_entry.word,
        concat_ws(E'\n',
          'Word: ' || v_entry.word,
          case when v_entry.phonetic is not null then 'Phonetic: ' || v_entry.phonetic end,
          'Meaning: ' || v_entry.meaning,
          case when v_entry.example is not null then 'Example: ' || v_entry.example end,
          case when v_entry.example_translation is not null then 'Example translation: ' || v_entry.example_translation end
        ),
        '[]'::jsonb,
        v_entry.meaning,
        '[]'::jsonb,
        jsonb_build_array(
          jsonb_build_object(
            'index', 1,
            'type', 'short_answer',
            'correct_answer', v_entry.word,
            'answer_config', jsonb_build_object(
              'type', 'word_mistake',
              'word_entry_id', p_item_id,
              'normalized_word', v_entry.normalized_word
            )
          )
        ),
        'wrong',
        v_effective_at
      ) returning id into v_problem_id;

      insert into public.problem_set_problems (
        user_id, problem_set_id, problem_id
      ) values (p_user_id, v_problem_set_id, v_problem_id)
      on conflict (problem_set_id, problem_id) do nothing;

      insert into public.word_mistake_links (
        user_id, word_entry_id, problem_set_id, problem_id
      ) values (p_user_id, p_item_id, v_problem_set_id, v_problem_id);
    end if;
    v_wrong_problem_id := v_problem_id;
  elsif v_projection_applied and p_action = 'known'
        and v_progress.status = 'mastered' then
    update public.problems p
    set status = 'mastered',
        last_reviewed_date = v_effective_at,
        updated_at = now()
    from public.word_mistake_links l
    where l.user_id = p_user_id
      and l.word_entry_id = p_item_id
      and p.id = l.problem_id
      and p.user_id = p_user_id;
  end if;

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'session_id', p_session_id,
    'sequence', p_sequence,
    'item_id', p_item_id,
    'action', p_action,
    -- Optional on purpose: an idempotent replay returns the result JSON that
    -- was persisted when the observation first landed, which predates this
    -- field. Callers must treat a missing value as 'sm2'.
    'authority_mode', v_authority_mode,
    'progress', v_progress_json,
    'projection_applied', v_projection_applied,
    'replayed', false
  );

  insert into public.study_observations (
    id, user_id, device_id, request_id, session_id, sequence,
    item_id, action, mode, occurred_at, result
  ) values (
    v_observation_id, p_user_id, p_device_id, p_request_id, p_session_id,
    p_sequence, p_item_id, p_action, p_mode, p_occurred_at, v_result
  );

  -- Insert the canonical observation before its legacy projection because the
  -- latter has an immediate foreign key to study_observations.
  if p_action in ('known', 'unknown', 'skipped') then
    v_legacy_outcome := case when p_action = 'skipped' then 'skip' else p_action end;
    insert into public.word_review_events (
      user_id,
      word_entry_id,
      outcome,
      mode,
      source,
      device_id,
      wrong_problem_id,
      metadata,
      created_at,
      study_observation_id,
      request_id,
      session_id,
      sequence
    ) values (
      p_user_id,
      p_item_id,
      v_legacy_outcome,
      p_mode,
      case when p_device_id is null then 'web' else 'device' end,
      p_device_id,
      v_wrong_problem_id,
      '{}'::jsonb,
      v_effective_at,
      v_observation_id,
      p_request_id,
      p_session_id,
      p_sequence
    );
  end if;

  update public.study_sessions
  set next_sequence = next_sequence + 1,
      status = case when status = 'paused' then 'active' else status end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id;

  return v_result;
end;
$$;

revoke all on function public.record_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;
