-- Problem Mark annotation queue backstop
--
-- Three defects let the durable queue lose work without a trace:
--
--   1. The enqueue trigger swallowed every failure with `raise warning`, so a
--      Problem whose annotation head could not be written left no evidence.
--   2. Re-enqueueing cleared `lease_token` unconditionally. A worker still
--      processing the previous revision lost its lease, failed its next
--      renewal, and left its run row parked at 'processing' forever.
--   3. Claiming required `annotation.semantic_revision = problem.semantic_revision`.
--      A head left behind that revision was never selectable again — not by
--      the batch worker, not by the single-problem route.
--
-- Together these made the best-effort `after()` wake the only execution path:
-- when it was cut short, the annotation stayed pending with nothing to drain it.
--
-- Problem remains the authority. Nothing here may fail a Problem write.
--
-- Recovery for heads that were never created at all (an enqueue INSERT that
-- failed outright) is not covered here; that lands with
-- `requeue_all_problem_mark_annotations()`.

-- 1. Enqueue failure visibility ----------------------------------------------
create table public.problem_mark_enqueue_errors (
  id bigint generated always as identity primary key,
  problem_id uuid not null,
  semantic_revision bigint,
  error_text text not null,
  occurred_at timestamptz not null default clock_timestamp()
);

create index problem_mark_enqueue_errors_recent_idx
  on public.problem_mark_enqueue_errors (occurred_at desc);

create index problem_mark_enqueue_errors_problem_idx
  on public.problem_mark_enqueue_errors (problem_id, occurred_at desc);

alter table public.problem_mark_enqueue_errors enable row level security;
revoke all on table public.problem_mark_enqueue_errors
  from public, anon, authenticated;
grant all on table public.problem_mark_enqueue_errors to service_role;

-- 2. Enqueue: record failures, keep live leases -------------------------------
create or replace function public.enqueue_problem_mark_annotation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_preserve_lease boolean := false;
  v_error text;
begin
  if tg_op = 'UPDATE' then
    if new.semantic_revision = old.semantic_revision then
      return new;
    end if;

    -- A worker may still be processing the previous revision. Yanking its
    -- lease here would fail its next renewal and orphan the run row, so let it
    -- finish: its commit is rejected as stale anyway, and the head is already
    -- pending at the new revision.
    if old.lease_token is not null
       and old.lease_until > clock_timestamp()
       and exists (
         select 1
         from public.problem_mark_annotation_runs run
         where run.id = old.active_run_id
           and run.status = 'processing'
       ) then
      v_preserve_lease := true;
    end if;
  end if;

  insert into public.problem_mark_annotations (
    problem_id,
    semantic_revision,
    registry_revision_id,
    status,
    unresolved,
    last_error_code,
    completed_at,
    lease_token,
    lease_until,
    attempt_count,
    next_retry_at,
    updated_at
  ) values (
    new.id,
    new.semantic_revision,
    null,
    'pending',
    '[]'::jsonb,
    null,
    null,
    null,
    null,
    0,
    clock_timestamp(),
    clock_timestamp()
  )
  on conflict (problem_id) do update
  set semantic_revision = excluded.semantic_revision,
      registry_revision_id = null,
      status = 'pending',
      unresolved = '[]'::jsonb,
      last_error_code = null,
      completed_at = null,
      lease_token = case
        when v_preserve_lease then public.problem_mark_annotations.lease_token
        else null
      end,
      lease_until = case
        when v_preserve_lease then public.problem_mark_annotations.lease_until
        else null
      end,
      attempt_count = 0,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp();

  return new;
exception when others then
  -- Problem is authority: derived state must never make a valid Problem write
  -- fail. It must not be invisible either, so persist the reason first.
  -- Capture SQLERRM now: handling the inner block below resets it.
  v_error := sqlerrm;
  begin
    insert into public.problem_mark_enqueue_errors (
      problem_id,
      semantic_revision,
      error_text
    ) values (new.id, new.semantic_revision, v_error);
  exception when others then
    -- Bookkeeping must never become the reason a Problem write fails.
    null;
  end;
  raise warning 'problem mark enqueue failed for %: %', new.id, v_error;
  return new;
end;
$$;

-- 3. Claim: recover heads left behind the current revision --------------------
-- The head is realigned to the Problem's current revision at claim time. That
-- keeps `prepare_problem_mark_annotation` consistent: it requires the claimed
-- revision to match both the head and the Problem.
create or replace function public.claim_problem_mark_annotations(
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
  if p_limit not between 1 and 50
     or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_CLAIM';
  end if;

  with candidates as (
    select annotation.problem_id,
           problem.semantic_revision as current_revision
    from public.problem_mark_annotations annotation
    join public.problems problem on problem.id = annotation.problem_id
    where annotation.status in ('pending', 'failed')
      and annotation.next_retry_at <= clock_timestamp()
      and (
        annotation.lease_token is null
        or annotation.lease_until <= clock_timestamp()
      )
    -- Heads already at the current revision first; stale ones still get drained
    -- instead of being stranded.
    order by (annotation.semantic_revision = problem.semantic_revision) desc,
             annotation.next_retry_at,
             annotation.updated_at,
             annotation.problem_id
    for update of annotation skip locked
    limit p_limit
  ), claimed as (
    update public.problem_mark_annotations annotation
    set lease_token = gen_random_uuid(),
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = annotation.attempt_count + 1,
        semantic_revision = candidates.current_revision,
        updated_at = clock_timestamp()
    from candidates
    where annotation.problem_id = candidates.problem_id
    returning
      annotation.problem_id,
      annotation.semantic_revision,
      annotation.lease_token,
      annotation.lease_until,
      annotation.attempt_count
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'problem_id', claimed.problem_id,
    'semantic_revision', claimed.semantic_revision,
    'lease_token', claimed.lease_token,
    'lease_until', claimed.lease_until,
    'attempt_count', claimed.attempt_count
  ) order by claimed.problem_id), '[]'::jsonb)
  into v_result
  from claimed;

  return v_result;
end;
$$;

create or replace function public.claim_problem_mark_annotation(
  p_problem_id uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim jsonb;
begin
  if p_problem_id is null or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_CLAIM';
  end if;

  update public.problem_mark_annotations annotation
  set lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      attempt_count = annotation.attempt_count + 1,
      semantic_revision = problem.semantic_revision,
      updated_at = clock_timestamp()
  from public.problems problem
  where annotation.problem_id = p_problem_id
    and problem.id = annotation.problem_id
    and annotation.status in ('pending', 'failed')
    and annotation.next_retry_at <= clock_timestamp()
    and (
      annotation.lease_token is null
      or annotation.lease_until <= clock_timestamp()
    )
  returning jsonb_build_object(
    'problem_id', annotation.problem_id,
    'semantic_revision', annotation.semantic_revision,
    'lease_token', annotation.lease_token,
    'lease_until', annotation.lease_until,
    'attempt_count', annotation.attempt_count
  ) into v_claim;

  return v_claim;
end;
$$;

revoke all on function public.claim_problem_mark_annotations(integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_problem_mark_annotation(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_problem_mark_annotations(integer, integer)
  to service_role;
grant execute on function public.claim_problem_mark_annotation(uuid, integer)
  to service_role;
