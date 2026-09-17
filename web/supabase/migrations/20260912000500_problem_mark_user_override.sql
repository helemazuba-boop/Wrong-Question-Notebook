-- Problem Marks: user corrections and visibility
--
-- Problem Marks had no consumer and no way for a learner to correct one. Worse,
-- the commit path deleted every mark on a Problem before writing the AI result,
-- so any correction a learner made would have been erased by the next
-- re-annotation (which a Problem edit triggers through semantic_revision).
--
-- This adds an override flag, allows a `user` source, lets the owner manage
-- their own marks, and makes re-annotation preserve anything a learner set.

-- 1. Override flag ------------------------------------------------------------
alter table public.problem_marks
  add column if not exists is_user_override boolean not null default false;

-- 2. Allow a user source ------------------------------------------------------
alter table public.problem_marks
  drop constraint if exists problem_marks_source_check;

alter table public.problem_marks
  add constraint problem_marks_source_check
    check (source is null or source in ('ai', 'copy', 'user'));

create index if not exists problem_marks_problem_idx
  on public.problem_marks (problem_id);

-- 3. Owner-managed marks ------------------------------------------------------
grant insert, update, delete on table public.problem_marks to authenticated;

drop policy if exists problem_marks_owner_insert on public.problem_marks;
create policy problem_marks_owner_insert
  on public.problem_marks
for insert to authenticated
with check (
  exists (
    select 1
    from public.problems problem
    where problem.id = problem_marks.problem_id
      and problem.user_id = (select auth.uid())
  )
);

drop policy if exists problem_marks_owner_update on public.problem_marks;
create policy problem_marks_owner_update
  on public.problem_marks
for update to authenticated
using (
  exists (
    select 1
    from public.problems problem
    where problem.id = problem_marks.problem_id
      and problem.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.problems problem
    where problem.id = problem_marks.problem_id
      and problem.user_id = (select auth.uid())
  )
);

drop policy if exists problem_marks_owner_delete on public.problem_marks;
create policy problem_marks_owner_delete
  on public.problem_marks
for delete to authenticated
using (
  exists (
    select 1
    from public.problems problem
    where problem.id = problem_marks.problem_id
      and problem.user_id = (select auth.uid())
  )
);

-- 4. Re-annotation must not erase a correction --------------------------------
create or replace function public.apply_problem_mark_annotation(
  p_problem_id uuid,
  p_semantic_revision bigint,
  p_registry_revision_id bigint,
  p_assignments jsonb,
  p_unresolved jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_skill_keys jsonb;
  v_skill_assignment_count integer;
  v_skill_unresolved_count integer;
  v_skill_resolution text;
  v_run_id uuid;
  v_status text;
  v_assignment_count integer;
  v_unresolved_count integer;
begin
  select coalesce(jsonb_agg(mark.stable_key order by mark.stable_key), '[]'::jsonb)
  into v_skill_keys
  from public.knowledge_marks mark
  join public.subjects subject on subject.canonical_subject_key = mark.subject_key
  join public.problems problem on problem.subject_id = subject.id
  where problem.id = p_problem_id
    and problem.semantic_revision = p_semantic_revision
    and mark.kind = 'skill'
    and mark.status = 'active';

  select count(*) into v_skill_assignment_count
  from jsonb_array_elements(p_assignments) item
  join public.knowledge_marks mark on mark.stable_key = item ->> 'mark_key'
  where mark.kind = 'skill';

  select count(*) into v_skill_unresolved_count
  from jsonb_array_elements(p_unresolved) item
  where item ->> 'kind' = 'skill';

  v_skill_resolution := case
    when v_skill_unresolved_count > 0 then 'unresolved'
    when v_skill_assignment_count > 0 then 'selected'
    else 'no_applicable'
  end;

  perform private.validate_problem_mark_result(
    p_problem_id,
    p_semantic_revision,
    p_registry_revision_id,
    v_skill_keys,
    p_assignments,
    p_unresolved,
    v_skill_resolution
  );

  v_assignment_count := jsonb_array_length(p_assignments);
  v_unresolved_count := jsonb_array_length(p_unresolved);
  v_status := case when v_unresolved_count > 0 then 'unresolved' else 'resolved' end;

  insert into public.problem_mark_annotation_runs (
    problem_id,
    semantic_revision,
    registry_revision_id,
    status,
    skill_resolution,
    skill_candidate_keys,
    assignments,
    unresolved,
    completed_at
  ) values (
    p_problem_id,
    p_semantic_revision,
    p_registry_revision_id,
    v_status,
    v_skill_resolution,
    v_skill_keys,
    p_assignments,
    p_unresolved,
    clock_timestamp()
  ) returning id into v_run_id;

  -- Only derived marks are replaced. A learner's correction is theirs to keep,
  -- and an AI result colliding with one is dropped rather than overwriting it.
  delete from public.problem_marks
  where problem_id = p_problem_id
    and not is_user_override;

  insert into public.problem_marks (
    problem_id, mark_key, role, part_index,
    registry_revision_id, semantic_revision, source
  )
  select distinct
    p_problem_id,
    item ->> 'mark_key',
    item ->> 'role',
    case when item -> 'part_index' is null or item -> 'part_index' = 'null'::jsonb
      then null else (item ->> 'part_index')::smallint end,
    p_registry_revision_id,
    p_semantic_revision,
    'ai'
  from jsonb_array_elements(p_assignments) item
  on conflict (problem_id, part_index, mark_key) do nothing;

  update public.problem_mark_annotations
  set registry_revision_id = p_registry_revision_id,
      active_run_id = v_run_id,
      status = v_status,
      unresolved = p_unresolved,
      last_error_code = null,
      completed_at = clock_timestamp(),
      lease_token = null,
      lease_until = null,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where problem_id = p_problem_id
    and semantic_revision = p_semantic_revision
    and status in ('pending', 'failed');

  if not found then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;

  return jsonb_build_object(
    'run_id', v_run_id,
    'status', v_status,
    'assignments', v_assignment_count,
    'unresolved', v_unresolved_count
  );
end;
$$;

revoke all on function public.apply_problem_mark_annotation(
  uuid, bigint, bigint, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_problem_mark_annotation(
  uuid, bigint, bigint, jsonb, jsonb
) to service_role;
