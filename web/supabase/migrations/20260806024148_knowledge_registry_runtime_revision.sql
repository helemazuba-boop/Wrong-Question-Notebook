-- Registry revision pinning and durable Problem semantics.

-- 1. Exact Registry revision provenance --------------------------------------
create table public.knowledge_registry_revisions (
  id bigint generated always as identity primary key,
  source_repository text not null,
  source_sha text not null,
  schema_version integer not null,
  content_sha256 text not null,
  subject_count integer not null,
  mark_count integer not null,
  applied boolean not null,
  completed_at timestamptz not null default now(),
  constraint knowledge_registry_revisions_repository_check
    check (btrim(source_repository) <> ''),
  constraint knowledge_registry_revisions_source_sha_check
    check (source_sha ~ '^[0-9a-f]{40}$'),
  constraint knowledge_registry_revisions_schema_version_check
    check (schema_version = 1),
  constraint knowledge_registry_revisions_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint knowledge_registry_revisions_counts_check
    check (subject_count >= 0 and mark_count >= 0),
  constraint knowledge_registry_revisions_source_unique
    unique (source_repository, source_sha)
);

create index knowledge_registry_revisions_content_idx
  on public.knowledge_registry_revisions (content_sha256, completed_at desc);

create table public.knowledge_registry_state (
  singleton boolean primary key default true,
  active_revision_id bigint not null
    references public.knowledge_registry_revisions(id),
  updated_at timestamptz not null default now(),
  constraint knowledge_registry_state_singleton_check check (singleton)
);

alter table public.knowledge_registry_revisions enable row level security;
alter table public.knowledge_registry_state enable row level security;

revoke all on table public.knowledge_registry_revisions
  from public, anon, authenticated;
revoke all on table public.knowledge_registry_state
  from public, anon, authenticated;
grant select on table public.knowledge_registry_revisions to authenticated;
grant select on table public.knowledge_registry_state to authenticated;
grant all on table public.knowledge_registry_revisions to service_role;
grant all on table public.knowledge_registry_state to service_role;
grant usage, select on sequence public.knowledge_registry_revisions_id_seq
  to service_role;

create policy knowledge_registry_revisions_authenticated_select
  on public.knowledge_registry_revisions
for select to authenticated
using (true);

create policy knowledge_registry_state_authenticated_select
  on public.knowledge_registry_state
for select to authenticated
using (true);

create or replace function public.sync_knowledge_registry_revision(
  p_source_repository text,
  p_source_sha text,
  p_schema_version integer,
  p_content_sha256 text,
  p_artifact_text text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_artifact jsonb;
  v_actual_hash text;
  v_subjects jsonb;
  v_marks jsonb;
  v_existing public.knowledge_registry_revisions%rowtype;
  v_current public.knowledge_registry_revisions%rowtype;
  v_revision public.knowledge_registry_revisions%rowtype;
  v_applied boolean := true;
  v_sync_result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('wqn.knowledge_registry.sync')
  );

  if btrim(coalesce(p_source_repository, '')) = ''
     or p_source_sha !~ '^[0-9a-f]{40}$'
     or p_schema_version <> 1
     or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRY_PROVENANCE';
  end if;

  v_actual_hash := encode(
    extensions.digest(convert_to(p_artifact_text, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_actual_hash <> p_content_sha256 then
    raise exception using errcode = '22023', message = 'REGISTRY_CONTENT_HASH_MISMATCH';
  end if;

  begin
    v_artifact := p_artifact_text::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'INVALID_KNOWLEDGE_REGISTRY';
  end;

  if jsonb_typeof(v_artifact) <> 'object'
     or (v_artifact - 'schema_version' - 'subjects' - 'marks') <> '{}'::jsonb
     or jsonb_typeof(v_artifact -> 'schema_version') <> 'number'
     or (v_artifact ->> 'schema_version')::integer <> p_schema_version
     or jsonb_typeof(v_artifact -> 'subjects') <> 'array'
     or jsonb_typeof(v_artifact -> 'marks') <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_KNOWLEDGE_REGISTRY';
  end if;

  v_subjects := v_artifact -> 'subjects';
  v_marks := v_artifact -> 'marks';

  select * into v_existing
  from public.knowledge_registry_revisions
  where source_repository = p_source_repository
    and source_sha = p_source_sha;

  if found then
    if v_existing.content_sha256 <> p_content_sha256
       or v_existing.schema_version <> p_schema_version then
      raise exception using errcode = '22023', message = 'REGISTRY_SOURCE_PROVENANCE_CONFLICT';
    end if;

    return jsonb_build_object(
      'revision_id', v_existing.id,
      'source_sha', v_existing.source_sha,
      'content_sha256', v_existing.content_sha256,
      'schema_version', v_existing.schema_version,
      'subjects', v_existing.subject_count,
      'marks', v_existing.mark_count,
      'applied', v_existing.applied,
      'replayed', true
    );
  end if;

  select r.* into v_current
  from public.knowledge_registry_state s
  join public.knowledge_registry_revisions r on r.id = s.active_revision_id
  where s.singleton;

  if found and v_current.content_sha256 = p_content_sha256 then
    v_applied := false;
    v_sync_result := jsonb_build_object(
      'subjects', jsonb_array_length(v_subjects),
      'marks', jsonb_array_length(v_marks)
    );
  else
    if exists (
      select 1
      from public.knowledge_marks existing
      join jsonb_array_elements(v_marks) item
        on item ->> 'stable_key' = existing.stable_key
      where existing.subject_key <> item ->> 'subject'
         or existing.kind <> item ->> 'kind'
    ) then
      raise exception using errcode = '22023', message = 'REGISTRY_MARK_IDENTITY_MUTATION_FORBIDDEN';
    end if;

    v_sync_result := public.sync_knowledge_registry(v_subjects, v_marks);
  end if;

  insert into public.knowledge_registry_revisions (
    source_repository, source_sha, schema_version, content_sha256,
    subject_count, mark_count, applied
  ) values (
    p_source_repository,
    p_source_sha,
    p_schema_version,
    p_content_sha256,
    jsonb_array_length(v_subjects),
    jsonb_array_length(v_marks),
    v_applied
  ) returning * into v_revision;

  insert into public.knowledge_registry_state (
    singleton, active_revision_id, updated_at
  ) values (true, v_revision.id, now())
  on conflict (singleton) do update
  set active_revision_id = excluded.active_revision_id,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'revision_id', v_revision.id,
    'source_sha', v_revision.source_sha,
    'content_sha256', v_revision.content_sha256,
    'schema_version', v_revision.schema_version,
    'subjects', (v_sync_result ->> 'subjects')::integer,
    'marks', (v_sync_result ->> 'marks')::integer,
    'applied', v_revision.applied,
    'replayed', false
  );
end;
$$;

revoke all on function public.sync_knowledge_registry_revision(
  text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.sync_knowledge_registry_revision(
  text, text, integer, text, text
) to service_role;

-- 2. Problem semantic revision and durable annotation state ------------------
alter table public.problems
  add column semantic_revision bigint not null default 1;

alter table public.problems
  add constraint problems_semantic_revision_check check (semantic_revision >= 1);

alter table public.problem_marks
  add column registry_revision_id bigint
    references public.knowledge_registry_revisions(id),
  add column semantic_revision bigint,
  add column source text,
  add constraint problem_marks_semantic_revision_check
    check (semantic_revision is null or semantic_revision >= 1),
  add constraint problem_marks_source_check
    check (source is null or source in ('ai', 'copy'));

create table public.problem_mark_annotations (
  problem_id uuid primary key references public.problems(id) on delete cascade,
  semantic_revision bigint not null,
  registry_revision_id bigint
    references public.knowledge_registry_revisions(id),
  status text not null default 'pending',
  unresolved jsonb not null default '[]'::jsonb,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint problem_mark_annotations_revision_check check (semantic_revision >= 1),
  constraint problem_mark_annotations_status_check
    check (status in ('pending', 'resolved', 'unresolved', 'failed')),
  constraint problem_mark_annotations_unresolved_check
    check (jsonb_typeof(unresolved) = 'array'),
  constraint problem_mark_annotations_error_code_check
    check (last_error_code is null or length(last_error_code) between 1 and 100)
);

create index problem_mark_annotations_status_idx
  on public.problem_mark_annotations (status, updated_at, problem_id)
  where status in ('pending', 'unresolved', 'failed');

alter table public.problem_mark_annotations enable row level security;
revoke all on table public.problem_mark_annotations
  from public, anon, authenticated;
grant select on table public.problem_mark_annotations to authenticated;
grant all on table public.problem_mark_annotations to service_role;

create policy problem_mark_annotations_visible_problem_select
  on public.problem_mark_annotations
for select to authenticated
using (public.can_view_problem(problem_id));

create or replace function public.bump_problem_semantic_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_id is distinct from old.subject_id
     or new.title is distinct from old.title
     or new.content is distinct from old.content
     or new.parts is distinct from old.parts
     or new.solution_text is distinct from old.solution_text
     or new.assets is distinct from old.assets
     or new.solution_assets is distinct from old.solution_assets then
    new.semantic_revision := old.semantic_revision + 1;
  else
    new.semantic_revision := old.semantic_revision;
  end if;
  return new;
end;
$$;

create trigger bump_problem_semantic_revision_before_update
before update on public.problems
for each row execute function public.bump_problem_semantic_revision();

create or replace function public.enqueue_problem_mark_annotation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.semantic_revision = old.semantic_revision then
      return new;
    end if;
    delete from public.problem_marks where problem_id = new.id;
  end if;

  insert into public.problem_mark_annotations (
    problem_id, semantic_revision, registry_revision_id, status,
    unresolved, last_error_code, completed_at, updated_at
  ) values (
    new.id, new.semantic_revision, null, 'pending',
    '[]'::jsonb, null, null, now()
  )
  on conflict (problem_id) do update
  set semantic_revision = excluded.semantic_revision,
      registry_revision_id = null,
      status = 'pending',
      unresolved = '[]'::jsonb,
      last_error_code = null,
      completed_at = null,
      updated_at = now();

  return new;
exception when others then
  -- Problem is authority. Derived state must never make a valid Problem write fail.
  raise warning 'problem mark enqueue failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger enqueue_problem_mark_annotation_after_write
after insert or update on public.problems
for each row execute function public.enqueue_problem_mark_annotation();

insert into public.problem_mark_annotations (problem_id, semantic_revision)
select id, semantic_revision from public.problems
on conflict (problem_id) do nothing;

-- 3. Annotation context and state transitions --------------------------------
create or replace function public.get_problem_mark_annotation_context(
  p_problem_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
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
  ) into v_result
  from public.problems p
  join public.subjects s on s.id = p.subject_id
  join public.problem_mark_annotations a
    on a.problem_id = p.id and a.semantic_revision = p.semantic_revision
  left join public.knowledge_registry_state rs on rs.singleton
  left join public.knowledge_registry_revisions r on r.id = rs.active_revision_id
  where p.id = p_problem_id;

  if v_result is null then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_CONTEXT_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

create or replace function public.apply_problem_mark_annotation(
  p_problem_id uuid,
  p_semantic_revision bigint,
  p_registry_revision_id bigint,
  p_assignments jsonb,
  p_unresolved jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_subject_key text;
  v_active_revision_id bigint;
  v_status text;
  v_assignment_count integer;
  v_unresolved_count integer;
begin
  if jsonb_typeof(p_assignments) <> 'array'
     or jsonb_typeof(p_unresolved) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_RESULT';
  end if;

  if not exists (
    select 1 from public.problem_mark_annotations a
    where a.problem_id = p_problem_id
      and a.semantic_revision = p_semantic_revision
      and a.status in ('pending', 'failed')
  ) then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;

  select s.canonical_subject_key into v_subject_key
  from public.problems p
  join public.subjects s on s.id = p.subject_id
  where p.id = p_problem_id and p.semantic_revision = p_semantic_revision;
  if not found then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;

  select active_revision_id into v_active_revision_id
  from public.knowledge_registry_state where singleton;
  if v_active_revision_id is distinct from p_registry_revision_id then
    raise exception using errcode = '40001', message = 'REGISTRY_REVISION_STALE';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_assignments) item
    left join public.knowledge_marks m on m.stable_key = item ->> 'mark_key'
    where m.stable_key is null
       or m.status <> 'active'
       or m.subject_key is distinct from v_subject_key
       or item ->> 'role' not in ('target', 'required')
       or (item - 'mark_key' - 'role' - 'part_index') <> '{}'::jsonb
       or (
         item ? 'part_index'
         and item -> 'part_index' <> 'null'::jsonb
         and (
           jsonb_typeof(item -> 'part_index') <> 'number'
           or (item ->> 'part_index')::integer not between 1 and 10
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
           or (item ->> 'part_index')::integer not between 1 and 10
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_UNRESOLVED';
  end if;

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

  v_assignment_count := jsonb_array_length(p_assignments);
  v_unresolved_count := jsonb_array_length(p_unresolved);
  v_status := case when v_unresolved_count > 0 then 'unresolved' else 'resolved' end;

  update public.problem_mark_annotations
  set registry_revision_id = p_registry_revision_id,
      status = v_status,
      unresolved = p_unresolved,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
  where problem_id = p_problem_id
    and semantic_revision = p_semantic_revision;

  return jsonb_build_object(
    'status', v_status,
    'assignments', v_assignment_count,
    'unresolved', v_unresolved_count
  );
end;
$$;

create or replace function public.fail_problem_mark_annotation(
  p_problem_id uuid,
  p_semantic_revision bigint,
  p_error_code text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if btrim(coalesce(p_error_code, '')) = '' then
    raise exception using errcode = '22023', message = 'INVALID_ANNOTATION_FAILURE';
  end if;

  update public.problem_mark_annotations
  set status = 'failed',
      last_error_code = left(p_error_code, 100),
      completed_at = now(),
      updated_at = now()
  where problem_id = p_problem_id
    and semantic_revision = p_semantic_revision
    and status in ('pending', 'failed');

  if not found then
    raise exception using errcode = '40001', message = 'PROBLEM_SEMANTIC_REVISION_STALE';
  end if;
end;
$$;

create or replace function public.requeue_problem_mark_annotation(
  p_problem_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_annotation public.problem_mark_annotations%rowtype;
begin
  select * into v_annotation
  from public.problem_mark_annotations
  where problem_id = p_problem_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_ANNOTATION_NOT_FOUND';
  end if;
  if v_annotation.status not in ('unresolved', 'failed') then
    raise exception using errcode = '22023', message = 'PROBLEM_MARK_ANNOTATION_NOT_REQUEUEABLE';
  end if;

  delete from public.problem_marks where problem_id = p_problem_id;
  update public.problem_mark_annotations
  set registry_revision_id = null,
      status = 'pending',
      unresolved = '[]'::jsonb,
      last_error_code = null,
      completed_at = null,
      updated_at = now()
  where problem_id = p_problem_id;

  return jsonb_build_object(
    'problem_id', p_problem_id,
    'semantic_revision', v_annotation.semantic_revision,
    'status', 'pending'
  );
end;
$$;

revoke all on function public.get_problem_mark_annotation_context(uuid)
  from public, anon, authenticated;
revoke all on function public.apply_problem_mark_annotation(
  uuid, bigint, bigint, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_problem_mark_annotation(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.requeue_problem_mark_annotation(uuid)
  from public, anon, authenticated;
grant execute on function public.get_problem_mark_annotation_context(uuid)
  to service_role;
grant execute on function public.apply_problem_mark_annotation(
  uuid, bigint, bigint, jsonb, jsonb
) to service_role;
grant execute on function public.fail_problem_mark_annotation(uuid, bigint, text)
  to service_role;
grant execute on function public.requeue_problem_mark_annotation(uuid)
  to service_role;

-- 4. Stable read contract ----------------------------------------------------
create or replace function public.get_problem_semantics(p_problem_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin')
     and not public.can_view_problem(p_problem_id) then
    raise exception using errcode = '42501', message = 'PROBLEM_NOT_VISIBLE';
  end if;

  select jsonb_build_object(
    'registry_revision', case when r.id is null then null else jsonb_build_object(
      'id', r.id,
      'source_sha', r.source_sha,
      'content_sha256', r.content_sha256,
      'schema_version', r.schema_version
    ) end,
    'semantic_revision', p.semantic_revision,
    'annotation_status', coalesce(a.status, 'pending'),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'part_index', pm.part_index,
        'mark', jsonb_build_object(
          'stable_key', m.stable_key,
          'name', m.name,
          'kind', m.kind,
          'subject', m.subject_key,
          'status', m.status,
          'parent', m.parent_key
        )
      ) order by pm.part_index nulls first, m.stable_key)
      from public.problem_marks pm
      join public.knowledge_marks m on m.stable_key = pm.mark_key
      where pm.problem_id = p.id
        and pm.role = 'target'
        and pm.semantic_revision = p.semantic_revision
        and pm.registry_revision_id = a.registry_revision_id
    ), '[]'::jsonb),
    'required', jsonb_build_object(
      'knowledge', coalesce((
        select jsonb_agg(jsonb_build_object(
          'part_index', pm.part_index,
          'mark', jsonb_build_object(
            'stable_key', m.stable_key,
            'name', m.name,
            'kind', m.kind,
            'subject', m.subject_key,
            'status', m.status,
            'parent', m.parent_key
          )
        ) order by pm.part_index nulls first, m.stable_key)
        from public.problem_marks pm
        join public.knowledge_marks m on m.stable_key = pm.mark_key
        where pm.problem_id = p.id
          and pm.role = 'required'
          and m.kind = 'knowledge'
          and pm.semantic_revision = p.semantic_revision
          and pm.registry_revision_id = a.registry_revision_id
      ), '[]'::jsonb),
      'skills', coalesce((
        select jsonb_agg(jsonb_build_object(
          'part_index', pm.part_index,
          'mark', jsonb_build_object(
            'stable_key', m.stable_key,
            'name', m.name,
            'kind', m.kind,
            'subject', m.subject_key,
            'status', m.status,
            'parent', m.parent_key
          )
        ) order by pm.part_index nulls first, m.stable_key)
        from public.problem_marks pm
        join public.knowledge_marks m on m.stable_key = pm.mark_key
        where pm.problem_id = p.id
          and pm.role = 'required'
          and m.kind = 'skill'
          and pm.semantic_revision = p.semantic_revision
          and pm.registry_revision_id = a.registry_revision_id
      ), '[]'::jsonb)
    ),
    'unresolved', coalesce(a.unresolved, '[]'::jsonb)
  ) into v_result
  from public.problems p
  left join public.problem_mark_annotations a
    on a.problem_id = p.id and a.semantic_revision = p.semantic_revision
  left join public.knowledge_registry_revisions r
    on r.id = a.registry_revision_id
  where p.id = p_problem_id;

  return coalesce(v_result, jsonb_build_object(
    'registry_revision', null,
    'semantic_revision', null,
    'annotation_status', 'pending',
    'targets', '[]'::jsonb,
    'required', jsonb_build_object('knowledge', '[]'::jsonb, 'skills', '[]'::jsonb),
    'unresolved', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.get_problem_semantics(uuid) from public, anon;
grant execute on function public.get_problem_semantics(uuid)
  to authenticated, service_role;

-- 5. Best-effort Copy inheritance -------------------------------------------
create or replace function public.inherit_problem_marks(p_mappings jsonb)
returns jsonb
language plpgsql
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

      select p.semantic_revision, s.canonical_subject_key
        into v_source_revision, v_source_subject
      from public.problems p
      join public.subjects s on s.id = p.subject_id
      where p.id = v_source_id;

      select p.semantic_revision, s.canonical_subject_key
        into v_destination_revision, v_destination_subject
      from public.problems p
      join public.subjects s on s.id = p.subject_id
      where p.id = v_destination_id;

      if v_source_revision is null or v_destination_revision is null then
        raise exception using errcode = '23503', message = 'PROBLEM_MARK_COPY_PROBLEM_NOT_FOUND';
      end if;

      select * into v_source_annotation
      from public.problem_mark_annotations
      where problem_id = v_source_id
        and semantic_revision = v_source_revision;

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
            updated_at = now()
        where problem_id = v_destination_id;
        v_pending := v_pending + 1;
        continue;
      end if;

      delete from public.problem_marks where problem_id = v_destination_id;
      insert into public.problem_marks (
        problem_id, mark_key, role, part_index,
        registry_revision_id, semantic_revision, source
      )
      select
        v_destination_id, mark_key, role, part_index,
        registry_revision_id, v_destination_revision, 'copy'
      from public.problem_marks
      where problem_id = v_source_id
        and semantic_revision = v_source_revision
        and registry_revision_id = v_source_annotation.registry_revision_id;

      update public.problem_mark_annotations
      set registry_revision_id = v_source_annotation.registry_revision_id,
          status = v_source_annotation.status,
          unresolved = v_source_annotation.unresolved,
          last_error_code = null,
          completed_at = now(),
          updated_at = now()
      where problem_id = v_destination_id;
      v_inherited := v_inherited + 1;
    exception when others then
      -- Mark inheritance is derived and never rolls back the copied Problem.
      update public.problem_mark_annotations
      set registry_revision_id = null,
          status = 'pending',
          unresolved = '[]'::jsonb,
          last_error_code = 'COPY_INHERITANCE_FAILED',
          completed_at = null,
          updated_at = now()
      where problem_id = v_destination_id;
      v_pending := v_pending + 1;
    end;
  end loop;

  return jsonb_build_object(
    'inherited', v_inherited,
    'pending', v_pending
  );
end;
$$;

revoke all on function public.inherit_problem_marks(jsonb)
  from public, anon, authenticated;
grant execute on function public.inherit_problem_marks(jsonb) to service_role;
