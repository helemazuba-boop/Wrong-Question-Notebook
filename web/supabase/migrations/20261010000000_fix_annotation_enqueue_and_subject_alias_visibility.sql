-- CI exposed a trigger reading lease fields from a problems row and an alias
-- table whose SELECT grant had no RLS policy. Preserve published migrations.

create policy subject_canonical_aliases_authenticated_select
  on public.subject_canonical_aliases
  for select to authenticated using (true);

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
    -- OLD is a problems row. The lease belongs to the annotation head.
    select exists (
      select 1
      from public.problem_mark_annotations annotation
      join public.problem_mark_annotation_runs run
        on run.id = annotation.active_run_id
      where annotation.problem_id = new.id
        and annotation.lease_token is not null
        and annotation.lease_until > clock_timestamp()
        and run.status = 'processing'
    ) into v_preserve_lease;
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
