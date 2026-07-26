-- Problem Review v1: device-side self-assessment for the problem domain.
--
-- The device reviews problems from problem-set packs and reports one of four
-- verdicts per problem (correct / hesitant / wrong / skip). This migration
-- adds the idempotent observation ledger plus record_problem_review_v1, which
-- ports the web self-assessment chain into a single transaction:
--   attempts insert (is_self_assessed) -> problems.status/last_reviewed_date
--   -> SM-2 review_schedule advancement (lib/spaced-repetition.ts semantics,
--      including the same-day guard and the user_profiles.timezone lookup).
-- skip only records the observation; no projection is touched.
-- Additive + idempotent; no contract hard-switch.

-- 1. Observation ledger ------------------------------------------------------
create table if not exists public.problem_review_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid,
  request_id text not null,
  problem_id uuid not null references public.problems(id) on delete cascade,
  action text not null,
  occurred_at timestamptz not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint problem_review_observations_action_check
    check (action in ('correct', 'hesitant', 'wrong', 'skip')),
  constraint problem_review_observations_request_id_check
    check (request_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  constraint problem_review_observations_result_check
    check (jsonb_typeof(result) = 'object')
);

create unique index if not exists problem_review_observations_actor_request_uidx
  on public.problem_review_observations (
    user_id,
    coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    request_id
  );

create index if not exists idx_problem_review_observations_problem
  on public.problem_review_observations (user_id, problem_id, occurred_at desc);

alter table public.problem_review_observations enable row level security;
revoke all on table public.problem_review_observations from anon, authenticated;
grant select on table public.problem_review_observations to authenticated;
grant all on table public.problem_review_observations to service_role;

drop policy if exists problem_review_observations_owner_select
  on public.problem_review_observations;
create policy problem_review_observations_owner_select
  on public.problem_review_observations
for select to authenticated
using ((select auth.uid()) = user_id);

-- 2. record_problem_review_v1 ------------------------------------------------
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
  v_schedule public.review_schedule%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_status text;
  v_quality integer;
  v_tz text := 'UTC';
  v_today date;
  v_rep integer;
  v_ef double precision;
  v_interval integer;
  v_next_review_at timestamptz;
  v_schedule_json jsonb := 'null'::jsonb;
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
  from public.problem_review_observations o
  where o.user_id = p_user_id
    and o.device_id is not distinct from p_device_id
    and o.request_id = p_request_id;

  if found then
    if v_existing.problem_id <> p_problem_id
       or v_existing.action <> p_action
       or v_existing.occurred_at <> p_occurred_at then
      raise exception using errcode = '23505', message = 'REVIEW_REQUEST_ID_REUSED';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_problem
  from public.problems p
  where p.id = p_problem_id and p.user_id = p_user_id
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
    -- mapStatusToQuality: wrong -> 1, needs_review -> 3, mastered -> 5
    v_quality := case v_status
      when 'mastered' then 5
      when 'needs_review' then 3
      else 1
    end;

    -- Self-assessed attempt: no device-side answering in v1, so the submitted
    -- answer is json null and is_correct stays null (auto-marking only).
    insert into public.attempts (
      user_id, problem_id, submitted_answer, is_self_assessed, selected_status
    ) values (
      p_user_id, p_problem_id, 'null'::jsonb, true, v_status
    );

    update public.problems
    set status = v_status::public.problem_status_enum,
        last_reviewed_date = now(),
        updated_at = now()
    where id = p_problem_id;

    -- Timezone: user_profiles.timezone with UTC fallback (getUserTimezone).
    begin
      select coalesce(nullif(trim(up.timezone), ''), 'UTC') into v_tz
      from public.user_profiles up
      where up.id = p_user_id;
      if not found or v_tz is null then
        v_tz := 'UTC';
      end if;
      perform now() at time zone v_tz;
    exception when others then
      v_tz := 'UTC';
    end;
    v_today := (now() at time zone v_tz)::date;

    select * into v_schedule
    from public.review_schedule rs
    where rs.user_id = p_user_id and rs.problem_id = p_problem_id
    for update;

    if found
       and v_schedule.last_reviewed_at is not null
       and (v_schedule.last_reviewed_at at time zone v_tz)::date = v_today then
      -- Same-day guard: keep SM-2 state, only refresh next_review_at.
      v_rep := v_schedule.repetition_number;
      v_ef := v_schedule.ease_factor;
      v_interval := coalesce(v_schedule.interval_days, 1);
    else
      v_rep := coalesce(v_schedule.repetition_number, 0);
      v_ef := coalesce(v_schedule.ease_factor, 2.5);
      v_interval := coalesce(v_schedule.interval_days, 1);

      if v_quality >= 3 then
        v_rep := v_rep + 1;
        if v_rep = 1 then
          v_interval := 1;
        elsif v_rep = 2 then
          v_interval := 3;
        else
          v_interval := round((v_interval * v_ef)::numeric)::integer;
        end if;
        -- EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02)), floor 1.3
        v_ef := greatest(
          v_ef + (0.1 - (5 - v_quality) * (0.08 + (5 - v_quality) * 0.02)),
          1.3
        );
      else
        v_rep := 0;
        v_interval := 1;
        -- EF unchanged on failure.
      end if;
    end if;

    -- getLocalMidnightAfterDays: local midnight of today+interval in v_tz.
    v_next_review_at := ((v_today + v_interval)::timestamp) at time zone v_tz;

    insert into public.review_schedule (
      user_id, problem_id, next_review_at, interval_days, ease_factor,
      repetition_number, last_reviewed_at, updated_at
    ) values (
      p_user_id, p_problem_id, v_next_review_at, v_interval, v_ef,
      v_rep, now(), now()
    )
    on conflict (user_id, problem_id) do update
    set next_review_at = excluded.next_review_at,
        interval_days = excluded.interval_days,
        ease_factor = excluded.ease_factor,
        repetition_number = excluded.repetition_number,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at;

    v_schedule_json := jsonb_build_object(
      'next_review_at', v_next_review_at,
      'interval_days', v_interval,
      'ease_factor', v_ef,
      'repetition_number', v_rep
    );
  end if;

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'problem_id', p_problem_id,
    'action', p_action,
    'status', coalesce(v_status, v_problem.status::text),
    'schedule', v_schedule_json,
    'projection_applied', p_action <> 'skip',
    'replayed', false
  );

  insert into public.problem_review_observations (
    id, user_id, device_id, request_id, problem_id, action, occurred_at, result
  ) values (
    v_observation_id, p_user_id, p_device_id, p_request_id, p_problem_id,
    p_action, p_occurred_at, v_result
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
