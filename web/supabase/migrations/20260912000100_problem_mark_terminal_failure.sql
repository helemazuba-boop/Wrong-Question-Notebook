-- Problem Mark annotation: bounded failure
--
-- Every failure — permanent contract violations and transient provider blips
-- alike — landed in the same `failed` state with a capped but endless backoff.
-- A Problem whose Registry lock no longer matched, or whose retrieval contract
-- could not be satisfied, was retried forever: it kept consuming a claim slot
-- and a provider call each cycle, and nothing ever marked it done.
--
-- This adds a terminal `abandoned` state. Contract failures abandon on the
-- first attempt; everything else abandons once the attempt budget is spent.
-- `abandoned` is excluded from the claim candidates, so it no longer competes
-- for worker capacity, and it stays requeueable so an operator can retry after
-- the underlying cause is fixed.

-- 1. Terminal status ----------------------------------------------------------
alter table public.problem_mark_annotations
  drop constraint if exists problem_mark_annotations_status_check;

alter table public.problem_mark_annotations
  add constraint problem_mark_annotations_status_check
    check (
      status in ('pending', 'resolved', 'unresolved', 'failed', 'abandoned')
    );

-- 2. Abandoned stays recoverable ----------------------------------------------
-- `requeue_problem_mark_annotation` is the operator escape hatch (Phase 2 wires
-- it to the admin surface). Without this an abandoned annotation could never be
-- retried even after the cause was fixed.
create or replace function public.requeue_problem_mark_annotation(
  p_problem_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_annotation public.problem_mark_annotations%rowtype;
begin
  select * into v_annotation
  from public.problem_mark_annotations annotation
  where annotation.problem_id = p_problem_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_ANNOTATION_NOT_FOUND';
  end if;
  if v_annotation.status not in ('unresolved', 'failed', 'abandoned') then
    raise exception using errcode = '22023', message = 'PROBLEM_MARK_ANNOTATION_NOT_REQUEUEABLE';
  end if;
  if v_annotation.lease_token is not null
     and v_annotation.lease_until > clock_timestamp() then
    raise exception using errcode = '55000', message = 'PROBLEM_MARK_ANNOTATION_LEASED';
  end if;

  -- Requeueing recalculates the same objective revision. Preserve the current
  -- projection until a replacement run commits successfully.
  update public.problem_mark_annotations
  set status = 'pending',
      unresolved = '[]'::jsonb,
      last_error_code = null,
      completed_at = null,
      lease_token = null,
      lease_until = null,
      attempt_count = 0,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where problem_id = p_problem_id;

  return jsonb_build_object(
    'problem_id', p_problem_id,
    'semantic_revision', v_annotation.semantic_revision,
    'status', 'pending'
  );
end;
$$;

revoke all on function public.requeue_problem_mark_annotation(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_problem_mark_annotation(uuid)
  to service_role;

-- 3. Fail with an optional terminal decision ----------------------------------
-- Dropped rather than replaced: adding a parameter creates a new overload, and
-- leaving the three-argument signature in place would silently keep the old
-- endless-retry behaviour for any caller that does not pass the flag.
drop function if exists public.fail_problem_mark_annotation_run(uuid, uuid, text);

create function public.fail_problem_mark_annotation_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_terminal boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.problem_mark_annotation_runs%rowtype;
  v_annotation public.problem_mark_annotations%rowtype;
  v_delay_seconds integer;
  v_terminal boolean;
  k_attempt_limit constant integer := 8;
begin
  if btrim(coalesce(p_error_code, '')) = '' then
    raise exception using errcode = '22023', message = 'INVALID_ANNOTATION_FAILURE';
  end if;

  select * into v_run
  from public.problem_mark_annotation_runs run
  where run.id = p_run_id
  for update;
  if not found or v_run.status <> 'processing' then
    raise exception using errcode = '40001', message = 'PROBLEM_MARK_RUN_STALE';
  end if;

  select * into v_annotation
  from public.problem_mark_annotations annotation
  where annotation.problem_id = v_run.problem_id
  for update;
  if not found
     or v_annotation.semantic_revision <> v_run.semantic_revision
     or v_annotation.lease_token is distinct from p_lease_token
     or v_annotation.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'PROBLEM_MARK_LEASE_STALE';
  end if;

  -- A caller-declared contract failure ends now; anything else ends once the
  -- attempt budget is spent. `attempt_count` is incremented at claim time, so
  -- it is the number of attempts made including this one.
  v_terminal := coalesce(p_terminal, false)
                or v_annotation.attempt_count >= k_attempt_limit;

  update public.problem_mark_annotation_runs
  set status = 'failed',
      last_error_code = left(p_error_code, 100),
      completed_at = clock_timestamp()
  where id = p_run_id;

  if v_terminal then
    update public.problem_mark_annotations
    set status = 'abandoned',
        last_error_code = left(p_error_code, 100),
        completed_at = clock_timestamp(),
        lease_token = null,
        lease_until = null,
        next_retry_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where problem_id = v_run.problem_id
      and semantic_revision = v_run.semantic_revision;

    return jsonb_build_object(
      'run_id', p_run_id,
      'status', 'abandoned',
      'next_retry_at', null
    );
  end if;

  v_delay_seconds := least(
    3600,
    15 * (1 << least(greatest(v_annotation.attempt_count - 1, 0), 8))
  );

  update public.problem_mark_annotations
  set status = 'failed',
      last_error_code = left(p_error_code, 100),
      completed_at = clock_timestamp(),
      lease_token = null,
      lease_until = null,
      next_retry_at = clock_timestamp() + make_interval(secs => v_delay_seconds),
      updated_at = clock_timestamp()
  where problem_id = v_run.problem_id
    and semantic_revision = v_run.semantic_revision;

  return jsonb_build_object(
    'run_id', p_run_id,
    'status', 'failed',
    'next_retry_at', clock_timestamp() + make_interval(secs => v_delay_seconds)
  );
end;
$$;

revoke all on function public.fail_problem_mark_annotation_run(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_problem_mark_annotation_run(uuid, uuid, text, boolean)
  to service_role;
