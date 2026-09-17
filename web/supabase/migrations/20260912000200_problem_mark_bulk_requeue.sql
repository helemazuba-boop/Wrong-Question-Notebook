-- Problem Mark annotation: bulk requeue
--
-- `requeue_problem_mark_annotation` resets one Problem. There was no way to
-- reset many, and no way to repair a Problem whose annotation head was never
-- created at all.
--
-- Both matter when the Knowledge Registry lock changes: every annotation that
-- ran under the previous lock fails with REGISTRY_LOCK_MISMATCH, which Phase 1
-- correctly treats as terminal. Without a bulk reset the whole backlog would be
-- abandoned silently. This is the escape hatch that must run in the same change
-- as a lock bump.

create or replace function public.requeue_all_problem_mark_annotations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_created integer;
  v_requeued integer;
begin
  -- A Problem whose enqueue failed outright has no head row, and both claim
  -- paths select from that row, so it could never be picked up again. Recreate
  -- the head from the Problem's current revision.
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
  )
  select problem.id,
         problem.semantic_revision,
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
  from public.problems problem
  where not exists (
    select 1
    from public.problem_mark_annotations annotation
    where annotation.problem_id = problem.id
  );
  get diagnostics v_created = row_count;

  -- Reset everything unfinished to the Problem's current revision. Resolved
  -- annotations keep their projection; a live lease is left alone so in-flight
  -- work is never disturbed.
  update public.problem_mark_annotations annotation
  set semantic_revision = problem.semantic_revision,
      status = 'pending',
      unresolved = '[]'::jsonb,
      last_error_code = null,
      completed_at = null,
      lease_token = null,
      lease_until = null,
      attempt_count = 0,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp()
  from public.problems problem
  where problem.id = annotation.problem_id
    and annotation.status in ('pending', 'failed', 'unresolved', 'abandoned')
    and (
      annotation.lease_token is null
      or annotation.lease_until <= clock_timestamp()
    );
  get diagnostics v_requeued = row_count;

  return jsonb_build_object('created', v_created, 'requeued', v_requeued);
end;
$$;

revoke all on function public.requeue_all_problem_mark_annotations()
  from public, anon, authenticated;
grant execute on function public.requeue_all_problem_mark_annotations()
  to service_role;
