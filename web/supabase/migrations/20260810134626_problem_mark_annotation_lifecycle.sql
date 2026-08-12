-- Durable Problem Mark annotation lifecycle.
--
-- Problem content remains authoritative. Derived Marks from an older semantic
-- revision stay on disk while a replacement run is pending or failed, but the
-- stable read RPC continues to hide them through its semantic_revision filter.

create table public.problem_mark_annotation_runs (
  id uuid primary key default gen_random_uuid(),
  problem_id uuid not null references public.problems(id) on delete cascade,
  semantic_revision bigint not null,
  registry_revision_id bigint
    references public.knowledge_registry_revisions(id) on delete restrict,
  status text not null default 'processing',
  objective_snapshot_hash text,
  query_hash text,
  embedding_profile_id text,
  query_template_version text,
  retriever_version text,
  marking_model text,
  marking_prompt_version text,
  skill_resolution text,
  skill_candidate_keys jsonb not null default '[]'::jsonb,
  assignments jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '[]'::jsonb,
  retrieval_debug jsonb not null default '{}'::jsonb,
  copied_from_problem_id uuid references public.problems(id) on delete set null,
  copied_from_run_id uuid references public.problem_mark_annotation_runs(id)
    on delete set null,
  last_error_code text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint problem_mark_annotation_runs_revision_check
    check (semantic_revision >= 1),
  constraint problem_mark_annotation_runs_status_check
    check (status in ('processing', 'resolved', 'unresolved', 'failed', 'stale')),
  constraint problem_mark_annotation_runs_skill_resolution_check
    check (
      skill_resolution is null
      or skill_resolution in ('selected', 'no_applicable', 'unresolved')
    ),
  constraint problem_mark_annotation_runs_json_check
    check (
      jsonb_typeof(skill_candidate_keys) = 'array'
      and jsonb_typeof(assignments) = 'array'
      and jsonb_typeof(unresolved) = 'array'
      and jsonb_typeof(retrieval_debug) = 'object'
    ),
  constraint problem_mark_annotation_runs_hash_check
    check (
      (objective_snapshot_hash is null
        or objective_snapshot_hash ~ '^[0-9a-f]{64}$')
      and (query_hash is null or query_hash ~ '^[0-9a-f]{64}$')
    ),
  constraint problem_mark_annotation_runs_error_check
    check (last_error_code is null or length(last_error_code) between 1 and 100),
  constraint problem_mark_annotation_runs_terminal_check
    check (
      (status = 'processing' and completed_at is null)
      or (status <> 'processing' and completed_at is not null)
    )
);

create index problem_mark_annotation_runs_timeline_idx
  on public.problem_mark_annotation_runs (
    problem_id, semantic_revision, started_at desc, id desc
  );
create index problem_mark_annotation_runs_registry_idx
  on public.problem_mark_annotation_runs (registry_revision_id)
  where registry_revision_id is not null;
create unique index problem_mark_annotation_runs_processing_uidx
  on public.problem_mark_annotation_runs (problem_id, semantic_revision)
  where status = 'processing';

alter table public.problem_mark_annotation_runs enable row level security;
revoke all on table public.problem_mark_annotation_runs
  from public, anon, authenticated;
grant all on table public.problem_mark_annotation_runs to service_role;

alter table public.problem_mark_annotations
  add column active_run_id uuid
    references public.problem_mark_annotation_runs(id) on delete set null,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column attempt_count integer not null default 0,
  add column next_retry_at timestamptz not null default clock_timestamp(),
  add constraint problem_mark_annotations_attempt_count_check
    check (attempt_count >= 0),
  add constraint problem_mark_annotations_lease_check
    check (
      (lease_token is null and lease_until is null)
      or (lease_token is not null and lease_until is not null)
    );

create index problem_mark_annotations_claim_idx
  on public.problem_mark_annotations (next_retry_at, updated_at, problem_id)
  where status in ('pending', 'failed');
create index problem_mark_annotations_lease_idx
  on public.problem_mark_annotations (lease_until)
  where lease_token is not null;
create index problem_mark_annotations_active_run_idx
  on public.problem_mark_annotations (active_run_id)
  where active_run_id is not null;

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
  if v_annotation.status not in ('unresolved', 'failed') then
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

-- Reset the head for a new objective revision, but never erase the prior
-- projection before the replacement calculation commits.
create or replace function public.enqueue_problem_mark_annotation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.semantic_revision = old.semantic_revision then
    return new;
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
      lease_token = null,
      lease_until = null,
      attempt_count = 0,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp();

  return new;
exception when others then
  -- Problem is authority. Derived state must never make a valid Problem write fail.
  raise warning 'problem mark enqueue failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

create or replace function private.problem_mark_annotation_context_json(
  p_problem_id uuid,
  p_semantic_revision bigint
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'problem_id', p.id,
    'semantic_revision', p.semantic_revision,
    'annotation_status', a.status,
    'title', p.title,
    'content', p.content,
    'parts', p.parts,
    'solution_text', p.solution_text,
    'assets', p.assets,
    'solution_assets', p.solution_assets,
    'subject_key', s.canonical_subject_key,
    'registry_revision_id', r.id,
    'registry_source_sha', r.source_sha,
    'registry_content_sha256', r.content_sha256,
    'registry_schema_version', r.schema_version,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'stable_key', m.stable_key,
        'name', m.name,
        'kind', m.kind,
        'subject', m.subject_key,
        'aliases', to_jsonb(m.aliases),
        'description', m.description,
        'parent', m.parent_key,
        'include', to_jsonb(m.include_notes),
        'exclude', to_jsonb(m.exclude_notes)
      ) order by m.stable_key)
      from public.knowledge_marks m
      where m.subject_key = s.canonical_subject_key
        and m.status = 'active'
    ), '[]'::jsonb)
  )
  from public.problems p
  join public.subjects s on s.id = p.subject_id
  join public.problem_mark_annotations a
    on a.problem_id = p.id
    and a.semantic_revision = p.semantic_revision
  left join public.knowledge_registry_state rs on rs.singleton
  left join public.knowledge_registry_revisions r
    on r.id = rs.active_revision_id
  where p.id = p_problem_id
    and p.semantic_revision = p_semantic_revision;
$$;

revoke all on function private.problem_mark_annotation_context_json(uuid, bigint)
  from public, anon, authenticated;
grant execute on function private.problem_mark_annotation_context_json(uuid, bigint)
  to service_role;

-- Kept for compatibility and diagnostics. Mutating workers must claim a lease
-- and call prepare_problem_mark_annotation instead.
create or replace function public.get_problem_mark_annotation_context(
  p_problem_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_revision bigint;
  v_result jsonb;
begin
  select semantic_revision into v_revision
  from public.problems where id = p_problem_id;
  if not found then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_CONTEXT_NOT_FOUND';
  end if;

  v_result := private.problem_mark_annotation_context_json(
    p_problem_id,
    v_revision
  );
  if v_result is null then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_CONTEXT_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

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
    select annotation.problem_id
    from public.problem_mark_annotations annotation
    join public.problems problem on problem.id = annotation.problem_id
    where annotation.semantic_revision = problem.semantic_revision
      and annotation.status in ('pending', 'failed')
      and annotation.next_retry_at <= clock_timestamp()
      and (
        annotation.lease_token is null
        or annotation.lease_until <= clock_timestamp()
      )
    order by annotation.next_retry_at, annotation.updated_at, annotation.problem_id
    for update of annotation skip locked
    limit p_limit
  ), claimed as (
    update public.problem_mark_annotations annotation
    set lease_token = gen_random_uuid(),
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = annotation.attempt_count + 1,
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
      updated_at = clock_timestamp()
  from public.problems problem
  where annotation.problem_id = p_problem_id
    and problem.id = annotation.problem_id
    and annotation.semantic_revision = problem.semantic_revision
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

create or replace function public.prepare_problem_mark_annotation(
  p_problem_id uuid,
  p_semantic_revision bigint,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_annotation public.problem_mark_annotations%rowtype;
  v_context jsonb;
  v_run_id uuid;
begin
  select * into v_annotation
  from public.problem_mark_annotations annotation
  where annotation.problem_id = p_problem_id
  for update;

  if not found
     or v_annotation.semantic_revision <> p_semantic_revision
     or v_annotation.lease_token is distinct from p_lease_token
     or v_annotation.lease_until <= clock_timestamp()
     or v_annotation.status not in ('pending', 'failed') then
    raise exception using errcode = '40001', message = 'PROBLEM_MARK_LEASE_STALE';
  end if;

  if not exists (
    select 1 from public.problems problem
    where problem.id = p_problem_id
      and problem.semantic_revision = p_semantic_revision
  ) then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;

  v_context := private.problem_mark_annotation_context_json(
    p_problem_id,
    p_semantic_revision
  );
  if v_context is null then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_CONTEXT_NOT_FOUND';
  end if;

  select run.id into v_run_id
  from public.problem_mark_annotation_runs run
  where run.problem_id = p_problem_id
    and run.semantic_revision = p_semantic_revision
    and run.status = 'processing'
  for update;

  if v_run_id is null then
    insert into public.problem_mark_annotation_runs (
      problem_id,
      semantic_revision,
      registry_revision_id,
      status
    ) values (
      p_problem_id,
      p_semantic_revision,
      (v_context ->> 'registry_revision_id')::bigint,
      'processing'
    ) returning id into v_run_id;
  end if;

  return v_context || jsonb_build_object(
    'run_id', v_run_id,
    'lease_token', p_lease_token
  );
end;
$$;

revoke all on function public.claim_problem_mark_annotations(integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_problem_mark_annotation(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.prepare_problem_mark_annotation(uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.requeue_problem_mark_annotation(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_problem_mark_annotations(integer, integer)
  to service_role;
grant execute on function public.claim_problem_mark_annotation(uuid, integer)
  to service_role;
grant execute on function public.prepare_problem_mark_annotation(uuid, bigint, uuid)
  to service_role;
grant execute on function public.requeue_problem_mark_annotation(uuid)
  to service_role;

create or replace function private.validate_problem_mark_result(
  p_problem_id uuid,
  p_semantic_revision bigint,
  p_registry_revision_id bigint,
  p_skill_candidate_keys jsonb,
  p_assignments jsonb,
  p_unresolved jsonb,
  p_skill_resolution text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_key text;
  v_active_revision_id bigint;
begin
  if jsonb_typeof(p_skill_candidate_keys) <> 'array'
     or jsonb_typeof(p_assignments) <> 'array'
     or jsonb_typeof(p_unresolved) <> 'array'
     or p_skill_resolution not in ('selected', 'no_applicable', 'unresolved') then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_RESULT';
  end if;

  select subject.canonical_subject_key into v_subject_key
  from public.problems problem
  join public.subjects subject on subject.id = problem.subject_id
  where problem.id = p_problem_id
    and problem.semantic_revision = p_semantic_revision;
  if not found then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;

  select active_revision_id into v_active_revision_id
  from public.knowledge_registry_state where singleton;
  if v_active_revision_id is distinct from p_registry_revision_id then
    raise exception using errcode = '40001', message = 'REGISTRY_REVISION_STALE';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(p_skill_candidate_keys) candidate
    left join public.knowledge_marks mark on mark.stable_key = candidate
    where mark.stable_key is null
      or mark.kind <> 'skill'
      or mark.status <> 'active'
      or mark.subject_key is distinct from v_subject_key
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SKILL_CANDIDATE_SET';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_assignments) item
    left join public.knowledge_marks mark on mark.stable_key = item ->> 'mark_key'
    where mark.stable_key is null
      or mark.status <> 'active'
      or mark.subject_key is distinct from v_subject_key
      or item ->> 'role' not in ('target', 'required')
      or (item - 'mark_key' - 'role' - 'part_index') <> '{}'::jsonb
      or (
        mark.kind = 'skill'
        and not (p_skill_candidate_keys ? (item ->> 'mark_key'))
      )
      or (
        item ? 'part_index'
        and item -> 'part_index' <> 'null'::jsonb
        and (
          jsonb_typeof(item -> 'part_index') <> 'number'
          or not exists (
            select 1
            from public.problems problem,
                 jsonb_array_elements(problem.parts) part
            where problem.id = p_problem_id
              and problem.semantic_revision = p_semantic_revision
              and (part ->> 'index')::integer = (item ->> 'part_index')::integer
          )
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_ASSIGNMENT';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_assignments) item
    group by item ->> 'mark_key', item -> 'part_index'
    having count(distinct item ->> 'role') > 1
  ) then
    raise exception using errcode = '22023', message = 'PROBLEM_MARK_ROLE_CONFLICT';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_unresolved) item
    where item ->> 'role' not in ('target', 'required')
      or item ->> 'kind' not in ('knowledge', 'skill')
      or item ->> 'reason' not in (
        'no_registry_match', 'registry_empty', 'subject_unmapped',
        'insufficient_problem_context', 'invalid_model_output'
      )
      or (item - 'role' - 'kind' - 'part_index' - 'reason') <> '{}'::jsonb
      or (
        item ? 'part_index'
        and item -> 'part_index' <> 'null'::jsonb
        and (
          jsonb_typeof(item -> 'part_index') <> 'number'
          or not exists (
            select 1
            from public.problems problem,
                 jsonb_array_elements(problem.parts) part
            where problem.id = p_problem_id
              and problem.semantic_revision = p_semantic_revision
              and (part ->> 'index')::integer = (item ->> 'part_index')::integer
          )
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_UNRESOLVED';
  end if;

  if p_skill_resolution = 'selected' and (
       not exists (
         select 1 from jsonb_array_elements(p_assignments) item
         join public.knowledge_marks mark on mark.stable_key = item ->> 'mark_key'
         where mark.kind = 'skill'
       )
       or exists (
         select 1 from jsonb_array_elements(p_unresolved) item
         where item ->> 'kind' = 'skill'
       )
     ) then
    raise exception using errcode = '22023', message = 'INVALID_SKILL_RESOLUTION';
  end if;

  if p_skill_resolution = 'no_applicable' and (
       exists (
         select 1 from jsonb_array_elements(p_assignments) item
         join public.knowledge_marks mark on mark.stable_key = item ->> 'mark_key'
         where mark.kind = 'skill'
       )
       or exists (
         select 1 from jsonb_array_elements(p_unresolved) item
         where item ->> 'kind' = 'skill'
       )
     ) then
    raise exception using errcode = '22023', message = 'INVALID_SKILL_RESOLUTION';
  end if;

  if p_skill_resolution = 'unresolved' and not exists (
    select 1 from jsonb_array_elements(p_unresolved) item
    where item ->> 'kind' = 'skill'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SKILL_RESOLUTION';
  end if;
end;
$$;

revoke all on function private.validate_problem_mark_result(
  uuid, bigint, bigint, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function private.validate_problem_mark_result(
  uuid, bigint, bigint, jsonb, jsonb, jsonb, text
) to service_role;

create or replace function public.commit_problem_mark_annotation_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_objective_snapshot_hash text,
  p_query_hash text,
  p_embedding_profile_id text,
  p_query_template_version text,
  p_retriever_version text,
  p_marking_model text,
  p_marking_prompt_version text,
  p_skill_resolution text,
  p_skill_candidate_keys jsonb,
  p_assignments jsonb,
  p_unresolved jsonb,
  p_retrieval_debug jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.problem_mark_annotation_runs%rowtype;
  v_annotation public.problem_mark_annotations%rowtype;
  v_status text;
  v_assignment_count integer;
  v_unresolved_count integer;
begin
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
     or v_annotation.lease_until <= clock_timestamp()
     or not exists (
       select 1 from public.problems problem
       where problem.id = v_run.problem_id
         and problem.semantic_revision = v_run.semantic_revision
     ) then
    raise exception using errcode = '40001', message = 'PROBLEM_MARK_LEASE_STALE';
  end if;

  perform private.validate_problem_mark_result(
    v_run.problem_id,
    v_run.semantic_revision,
    v_run.registry_revision_id,
    p_skill_candidate_keys,
    p_assignments,
    p_unresolved,
    p_skill_resolution
  );

  if jsonb_typeof(p_retrieval_debug) <> 'object'
     or p_objective_snapshot_hash !~ '^[0-9a-f]{64}$'
     or p_query_hash !~ '^[0-9a-f]{64}$'
     or btrim(coalesce(p_embedding_profile_id, '')) = ''
     or btrim(coalesce(p_query_template_version, '')) = ''
     or btrim(coalesce(p_retriever_version, '')) = ''
     or btrim(coalesce(p_marking_model, '')) = ''
     or btrim(coalesce(p_marking_prompt_version, '')) = '' then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_RUN_PROVENANCE';
  end if;

  v_assignment_count := jsonb_array_length(p_assignments);
  v_unresolved_count := jsonb_array_length(p_unresolved);
  v_status := case when v_unresolved_count > 0 then 'unresolved' else 'resolved' end;

  delete from public.problem_marks
  where problem_id = v_run.problem_id;

  insert into public.problem_marks (
    problem_id,
    mark_key,
    role,
    part_index,
    registry_revision_id,
    semantic_revision,
    source
  )
  select distinct
    v_run.problem_id,
    item ->> 'mark_key',
    item ->> 'role',
    case
      when item -> 'part_index' is null or item -> 'part_index' = 'null'::jsonb
        then null
      else (item ->> 'part_index')::smallint
    end,
    v_run.registry_revision_id,
    v_run.semantic_revision,
    'ai'
  from jsonb_array_elements(p_assignments) item;

  update public.problem_mark_annotation_runs
  set status = v_status,
      objective_snapshot_hash = p_objective_snapshot_hash,
      query_hash = p_query_hash,
      embedding_profile_id = p_embedding_profile_id,
      query_template_version = p_query_template_version,
      retriever_version = p_retriever_version,
      marking_model = p_marking_model,
      marking_prompt_version = p_marking_prompt_version,
      skill_resolution = p_skill_resolution,
      skill_candidate_keys = p_skill_candidate_keys,
      assignments = p_assignments,
      unresolved = p_unresolved,
      retrieval_debug = p_retrieval_debug,
      last_error_code = null,
      completed_at = clock_timestamp()
  where id = p_run_id;

  update public.problem_mark_annotations
  set registry_revision_id = v_run.registry_revision_id,
      active_run_id = p_run_id,
      status = v_status,
      unresolved = p_unresolved,
      last_error_code = null,
      completed_at = clock_timestamp(),
      lease_token = null,
      lease_until = null,
      next_retry_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where problem_id = v_run.problem_id
    and semantic_revision = v_run.semantic_revision;

  return jsonb_build_object(
    'run_id', p_run_id,
    'status', v_status,
    'assignments', v_assignment_count,
    'unresolved', v_unresolved_count
  );
end;
$$;

create or replace function public.fail_problem_mark_annotation_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_error_code text
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

  v_delay_seconds := least(
    3600,
    15 * (1 << least(greatest(v_annotation.attempt_count - 1, 0), 8))
  );

  update public.problem_mark_annotation_runs
  set status = 'failed',
      last_error_code = left(p_error_code, 100),
      completed_at = clock_timestamp()
  where id = p_run_id;

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

revoke all on function public.commit_problem_mark_annotation_run(
  uuid, uuid, text, text, text, text, text, text, text, text,
  jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_problem_mark_annotation_run(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.commit_problem_mark_annotation_run(
  uuid, uuid, text, text, text, text, text, text, text, text,
  jsonb, jsonb, jsonb, jsonb
) to service_role;
grant execute on function public.fail_problem_mark_annotation_run(uuid, uuid, text)
  to service_role;

-- Compatibility writer for callers during Checkpoint A. It now records a run
-- and preserves old projections until this atomic call succeeds. Checkpoint D
-- moves runtime callers to the lease-bound commit RPC above.
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

  delete from public.problem_marks where problem_id = p_problem_id;
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
  from jsonb_array_elements(p_assignments) item;

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

-- New copies retain semantic origin and record copy provenance. Existing rows
-- with source='copy' are intentionally left untouched.
create or replace function public.inherit_problem_marks(p_mappings jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_mapping jsonb;
  v_source_id uuid;
  v_destination_id uuid;
  v_source_revision bigint;
  v_destination_revision bigint;
  v_source_subject text;
  v_destination_subject text;
  v_source_annotation public.problem_mark_annotations%rowtype;
  v_copy_run_id uuid;
  v_assignments jsonb;
  v_inherited integer := 0;
  v_pending integer := 0;
begin
  if jsonb_typeof(p_mappings) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_COPY_MAPPINGS';
  end if;

  for v_mapping in select value from jsonb_array_elements(p_mappings)
  loop
    begin
      if (v_mapping - 'source_problem_id' - 'destination_problem_id') <> '{}'::jsonb then
        raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_COPY_MAPPING';
      end if;
      v_source_id := (v_mapping ->> 'source_problem_id')::uuid;
      v_destination_id := (v_mapping ->> 'destination_problem_id')::uuid;

      select problem.semantic_revision, subject.canonical_subject_key
      into v_source_revision, v_source_subject
      from public.problems problem
      join public.subjects subject on subject.id = problem.subject_id
      where problem.id = v_source_id;

      select problem.semantic_revision, subject.canonical_subject_key
      into v_destination_revision, v_destination_subject
      from public.problems problem
      join public.subjects subject on subject.id = problem.subject_id
      where problem.id = v_destination_id;

      if v_source_revision is null or v_destination_revision is null then
        raise exception using errcode = '23503', message = 'PROBLEM_MARK_COPY_PROBLEM_NOT_FOUND';
      end if;

      select * into v_source_annotation
      from public.problem_mark_annotations annotation
      where annotation.problem_id = v_source_id
        and annotation.semantic_revision = v_source_revision;

      if v_source_subject is null
         or v_destination_subject is null
         or v_source_subject <> v_destination_subject
         or v_source_annotation.problem_id is null
         or v_source_annotation.status not in ('resolved', 'unresolved')
         or v_source_annotation.registry_revision_id is null then
        update public.problem_mark_annotations
        set registry_revision_id = null,
            status = 'pending',
            unresolved = '[]'::jsonb,
            last_error_code = 'COPY_INHERITANCE_UNAVAILABLE',
            completed_at = null,
            lease_token = null,
            lease_until = null,
            next_retry_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where problem_id = v_destination_id;
        v_pending := v_pending + 1;
        continue;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object(
        'mark_key', mark.mark_key,
        'role', mark.role,
        'part_index', mark.part_index
      ) order by mark.part_index nulls first, mark.mark_key), '[]'::jsonb)
      into v_assignments
      from public.problem_marks mark
      where mark.problem_id = v_source_id
        and mark.semantic_revision = v_source_revision
        and mark.registry_revision_id = v_source_annotation.registry_revision_id;

      insert into public.problem_mark_annotation_runs (
        problem_id,
        semantic_revision,
        registry_revision_id,
        status,
        skill_resolution,
        skill_candidate_keys,
        assignments,
        unresolved,
        copied_from_problem_id,
        copied_from_run_id,
        completed_at
      )
      select
        v_destination_id,
        v_destination_revision,
        v_source_annotation.registry_revision_id,
        v_source_annotation.status,
        coalesce(source_run.skill_resolution, 'no_applicable'),
        coalesce(source_run.skill_candidate_keys, '[]'::jsonb),
        v_assignments,
        v_source_annotation.unresolved,
        v_source_id,
        v_source_annotation.active_run_id,
        clock_timestamp()
      from (select 1) singleton
      left join public.problem_mark_annotation_runs source_run
        on source_run.id = v_source_annotation.active_run_id
      returning id into v_copy_run_id;

      delete from public.problem_marks where problem_id = v_destination_id;
      insert into public.problem_marks (
        problem_id, mark_key, role, part_index,
        registry_revision_id, semantic_revision, source
      )
      select
        v_destination_id,
        mark_key,
        role,
        part_index,
        registry_revision_id,
        v_destination_revision,
        source
      from public.problem_marks
      where problem_id = v_source_id
        and semantic_revision = v_source_revision
        and registry_revision_id = v_source_annotation.registry_revision_id;

      update public.problem_mark_annotations
      set registry_revision_id = v_source_annotation.registry_revision_id,
          active_run_id = v_copy_run_id,
          status = v_source_annotation.status,
          unresolved = v_source_annotation.unresolved,
          last_error_code = null,
          completed_at = clock_timestamp(),
          lease_token = null,
          lease_until = null,
          next_retry_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where problem_id = v_destination_id;
      v_inherited := v_inherited + 1;
    exception when others then
      update public.problem_mark_annotations
      set registry_revision_id = null,
          status = 'pending',
          unresolved = '[]'::jsonb,
          last_error_code = 'COPY_INHERITANCE_FAILED',
          completed_at = null,
          lease_token = null,
          lease_until = null,
          next_retry_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where problem_id = v_destination_id;
      v_pending := v_pending + 1;
    end;
  end loop;

  return jsonb_build_object('inherited', v_inherited, 'pending', v_pending);
end;
$$;

-- Runs may only move from processing to one terminal state. Account/Problem
-- cascades remain allowed for privacy deletion.
create or replace function private.guard_problem_mark_annotation_run_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'processing' then
    raise exception using errcode = '55000', message = 'PROBLEM_MARK_RUN_IMMUTABLE';
  end if;
  if new.id is distinct from old.id
     or new.problem_id is distinct from old.problem_id
     or new.semantic_revision is distinct from old.semantic_revision
     or new.registry_revision_id is distinct from old.registry_revision_id
     or new.status = 'processing'
     or new.started_at is distinct from old.started_at then
    raise exception using errcode = '55000', message = 'PROBLEM_MARK_RUN_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger guard_problem_mark_annotation_run_before_update
before update on public.problem_mark_annotation_runs
for each row execute function private.guard_problem_mark_annotation_run_update();

revoke all on function private.guard_problem_mark_annotation_run_update()
  from public, anon, authenticated;
grant execute on function private.guard_problem_mark_annotation_run_update()
  to service_role;
