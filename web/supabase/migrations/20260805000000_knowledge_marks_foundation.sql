-- Canonical Knowledge/Skill Mark foundation.
--
-- Git owns the reviewed vocabulary. These tables are its runtime projection plus
-- the derived relationship that describes what a problem targets or requires.

-- 1. Canonical subject and mark projections ----------------------------------
create table public.canonical_subjects (
  stable_key text primary key,
  name text not null,
  aliases text[] not null default '{}',
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canonical_subjects_stable_key_check
    check (stable_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
  constraint canonical_subjects_name_check check (btrim(name) <> ''),
  constraint canonical_subjects_aliases_check
    check (array_position(aliases, null) is null and '' <> all(aliases)),
  constraint canonical_subjects_status_check
    check (status in ('active', 'deprecated'))
);

create table public.knowledge_marks (
  stable_key text primary key,
  subject_key text not null references public.canonical_subjects(stable_key),
  kind text not null,
  name text not null,
  aliases text[] not null default '{}',
  description text,
  parent_key text,
  include_notes text[] not null default '{}',
  exclude_notes text[] not null default '{}',
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_marks_identity_unique
    unique (stable_key, subject_key, kind),
  constraint knowledge_marks_parent_fkey
    foreign key (parent_key, subject_key, kind)
    references public.knowledge_marks(stable_key, subject_key, kind),
  constraint knowledge_marks_stable_key_check
    check (
      stable_key ~ '^[a-z][a-z0-9_]*\.(knowledge|skill)\.[a-z0-9_]+(\.[a-z0-9_]+)*$'
      and stable_key like subject_key || '.' || kind || '.%'
    ),
  constraint knowledge_marks_kind_check check (kind in ('knowledge', 'skill')),
  constraint knowledge_marks_name_check check (btrim(name) <> ''),
  constraint knowledge_marks_description_check
    check (description is null or btrim(description) <> ''),
  constraint knowledge_marks_aliases_check
    check (array_position(aliases, null) is null and '' <> all(aliases)),
  constraint knowledge_marks_include_check
    check (array_position(include_notes, null) is null and '' <> all(include_notes)),
  constraint knowledge_marks_exclude_check
    check (array_position(exclude_notes, null) is null and '' <> all(exclude_notes)),
  constraint knowledge_marks_status_check
    check (status in ('active', 'deprecated'))
);

create index knowledge_marks_subject_kind_idx
  on public.knowledge_marks (subject_key, kind, stable_key);

-- Bootstrap the runtime subject projection so subjects can reference it before
-- the first standalone Registry projection. That projection must contain this
-- exact reviewed set.
insert into public.canonical_subjects (stable_key, name, aliases, status)
values
  ('chinese', '语文', array['Chinese'], 'active'),
  ('math', '数学', array['Mathematics'], 'active'),
  ('english', '英语', array['English', 'English Vocabulary'], 'active'),
  ('physics', '物理', array['Physics'], 'active'),
  ('chemistry', '化学', array['Chemistry'], 'active'),
  ('biology', '生物', array['Biology'], 'active'),
  ('history', '历史', array['History'], 'active'),
  ('geography', '地理', array['Geography'], 'active'),
  ('politics', '政治', array['Politics'], 'active'),
  ('information_technology', '信息技术', array['Information Technology'], 'active'),
  ('other', '其他', array['Other'], 'active');

-- 2. User subjects map many-to-one onto a canonical subject ------------------
alter table public.subjects
  add column canonical_subject_key text
  references public.canonical_subjects(stable_key);

update public.subjects
set canonical_subject_key = case name
  when '语文' then 'chinese'
  when '数学' then 'math'
  when '英语' then 'english'
  when '物理' then 'physics'
  when '化学' then 'chemistry'
  when '生物' then 'biology'
  when '历史' then 'history'
  when '地理' then 'geography'
  when '政治' then 'politics'
  when '信息技术' then 'information_technology'
  when '其他' then 'other'
  else null
end
where name in (
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '地理', '政治', '信息技术', '其他'
);

create index subjects_user_canonical_subject_idx
  on public.subjects (user_id, canonical_subject_key);

create or replace function public.map_subject_canonical_key()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_expected_key text := case new.name
    when '语文' then 'chinese'
    when '数学' then 'math'
    when '英语' then 'english'
    when '物理' then 'physics'
    when '化学' then 'chemistry'
    when '生物' then 'biology'
    when '历史' then 'history'
    when '地理' then 'geography'
    when '政治' then 'politics'
    when '信息技术' then 'information_technology'
    when '其他' then 'other'
    else null
  end;
begin
  if tg_op = 'INSERT' then
    if (select auth.role()) = 'authenticated'
       and new.canonical_subject_key is not null then
      raise exception using
        errcode = '42501',
        message = 'CANONICAL_SUBJECT_KEY_MANAGED';
    end if;

    if new.canonical_subject_key is null then
      new.canonical_subject_key := v_expected_key;
    end if;
  elsif (select auth.role()) = 'authenticated'
        and new.canonical_subject_key is distinct from old.canonical_subject_key then
    raise exception using
      errcode = '42501',
      message = 'CANONICAL_SUBJECT_KEY_MANAGED';
  end if;

  return new;
end;
$$;

create trigger map_subject_canonical_key_before_write
before insert or update of canonical_subject_key on public.subjects
for each row execute function public.map_subject_canonical_key();

-- 3. Problem semantic relationships -----------------------------------------
create table public.problem_marks (
  problem_id uuid not null references public.problems(id) on delete cascade,
  mark_key text not null references public.knowledge_marks(stable_key),
  role text not null,
  part_index smallint,
  created_at timestamptz not null default now(),
  constraint problem_marks_role_check check (role in ('target', 'required')),
  constraint problem_marks_part_index_check
    check (part_index is null or part_index between 1 and 10),
  constraint problem_marks_identity_unique
    unique nulls not distinct (problem_id, part_index, mark_key)
);

create index problem_marks_mark_problem_idx
  on public.problem_marks (mark_key, problem_id);

create or replace function public.validate_problem_mark()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parts jsonb;
  v_subject_key text;
  v_mark_subject_key text;
begin
  select p.parts, s.canonical_subject_key
    into v_parts, v_subject_key
  from public.problems p
  join public.subjects s on s.id = p.subject_id
  where p.id = new.problem_id;

  if not found then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_PROBLEM_NOT_FOUND';
  end if;

  select m.subject_key into v_mark_subject_key
  from public.knowledge_marks m
  where m.stable_key = new.mark_key;

  if not found then
    raise exception using errcode = '23503', message = 'PROBLEM_MARK_MARK_NOT_FOUND';
  end if;

  if v_subject_key is null then
    raise exception using errcode = '23514', message = 'PROBLEM_MARK_SUBJECT_UNMAPPED';
  end if;

  if v_subject_key <> v_mark_subject_key then
    raise exception using errcode = '23514', message = 'PROBLEM_MARK_SUBJECT_MISMATCH';
  end if;

  if new.part_index is not null and not exists (
    select 1
    from jsonb_array_elements(v_parts) part
    where (part ->> 'index')::smallint = new.part_index
  ) then
    raise exception using errcode = '23514', message = 'PROBLEM_MARK_PART_NOT_FOUND';
  end if;

  return new;
end;
$$;

create trigger validate_problem_mark_before_write
before insert or update on public.problem_marks
for each row execute function public.validate_problem_mark();

-- 4. Atomic Git Registry projection sync ------------------------------------
create or replace function public.sync_knowledge_registry(
  p_subjects jsonb,
  p_marks jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_subject_count integer := 0;
  v_mark_count integer := 0;
begin
  if jsonb_typeof(p_subjects) is distinct from 'array'
     or jsonb_typeof(p_marks) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_KNOWLEDGE_REGISTRY';
  end if;

  if exists (
    select 1
    from public.canonical_subjects existing
    where not exists (
      select 1
      from jsonb_array_elements(p_subjects) item
      where item ->> 'stable_key' = existing.stable_key
    )
  ) then
    raise exception using errcode = '22023', message = 'REGISTRY_SUBJECT_REMOVAL_FORBIDDEN';
  end if;

  if exists (
    select item ->> 'stable_key'
    from jsonb_array_elements(p_subjects) item
    group by item ->> 'stable_key'
    having count(*) > 1
  ) or exists (
    select item ->> 'stable_key'
    from jsonb_array_elements(p_marks) item
    group by item ->> 'stable_key'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'REGISTRY_DUPLICATE_STABLE_KEY';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_marks) item
    where not exists (
      select 1
      from jsonb_array_elements(p_subjects) subject
      where subject ->> 'stable_key' = item ->> 'subject'
    )
  ) then
    raise exception using errcode = '22023', message = 'REGISTRY_MARK_SUBJECT_NOT_DECLARED';
  end if;

  if exists (
    select 1
    from public.knowledge_marks existing
    where not exists (
      select 1
      from jsonb_array_elements(p_marks) item
      where item ->> 'stable_key' = existing.stable_key
    )
  ) then
    raise exception using errcode = '22023', message = 'REGISTRY_MARK_REMOVAL_FORBIDDEN';
  end if;

  for v_item in select value from jsonb_array_elements(p_subjects)
  loop
    insert into public.canonical_subjects (
      stable_key, name, aliases, status, updated_at
    ) values (
      v_item ->> 'stable_key',
      v_item ->> 'name',
      array(
        select btrim(value)
        from jsonb_array_elements_text(coalesce(v_item -> 'aliases', '[]'::jsonb))
      ),
      v_item ->> 'status',
      now()
    )
    on conflict (stable_key) do update
    set name = excluded.name,
        aliases = excluded.aliases,
        status = excluded.status,
        updated_at = excluded.updated_at
    where public.canonical_subjects.name is distinct from excluded.name
       or public.canonical_subjects.aliases is distinct from excluded.aliases
       or public.canonical_subjects.status is distinct from excluded.status;
    v_subject_count := v_subject_count + 1;
  end loop;

  -- Parents may appear after children in Git. Upsert identities first, then
  -- attach parent_key in a second pass inside the same transaction.
  for v_item in select value from jsonb_array_elements(p_marks)
  loop
    insert into public.knowledge_marks (
      stable_key, subject_key, kind, name, aliases, description,
      parent_key, include_notes, exclude_notes, status, updated_at
    ) values (
      v_item ->> 'stable_key',
      v_item ->> 'subject',
      v_item ->> 'kind',
      v_item ->> 'name',
      array(
        select btrim(value)
        from jsonb_array_elements_text(coalesce(v_item -> 'aliases', '[]'::jsonb))
      ),
      nullif(btrim(v_item ->> 'description'), ''),
      null,
      array(
        select btrim(value)
        from jsonb_array_elements_text(coalesce(v_item -> 'include', '[]'::jsonb))
      ),
      array(
        select btrim(value)
        from jsonb_array_elements_text(coalesce(v_item -> 'exclude', '[]'::jsonb))
      ),
      v_item ->> 'status',
      now()
    )
    on conflict (stable_key) do update
    set subject_key = excluded.subject_key,
        kind = excluded.kind,
        name = excluded.name,
        aliases = excluded.aliases,
        description = excluded.description,
        parent_key = null,
        include_notes = excluded.include_notes,
        exclude_notes = excluded.exclude_notes,
        status = excluded.status,
        updated_at = excluded.updated_at
    where public.knowledge_marks.subject_key is distinct from excluded.subject_key
       or public.knowledge_marks.kind is distinct from excluded.kind
       or public.knowledge_marks.name is distinct from excluded.name
       or public.knowledge_marks.aliases is distinct from excluded.aliases
       or public.knowledge_marks.description is distinct from excluded.description
       or public.knowledge_marks.parent_key is not null
       or public.knowledge_marks.include_notes is distinct from excluded.include_notes
       or public.knowledge_marks.exclude_notes is distinct from excluded.exclude_notes
       or public.knowledge_marks.status is distinct from excluded.status;
    v_mark_count := v_mark_count + 1;
  end loop;

  for v_item in select value from jsonb_array_elements(p_marks)
  loop
    update public.knowledge_marks
    set parent_key = nullif(v_item ->> 'parent', ''),
        updated_at = now()
    where stable_key = v_item ->> 'stable_key'
      and parent_key is distinct from nullif(v_item ->> 'parent', '');
  end loop;

  return jsonb_build_object(
    'subjects', v_subject_count,
    'marks', v_mark_count
  );
end;
$$;

-- 5. Runtime projection permissions -----------------------------------------
alter table public.canonical_subjects enable row level security;
alter table public.knowledge_marks enable row level security;
alter table public.problem_marks enable row level security;

revoke all on table public.canonical_subjects from public, anon, authenticated;
revoke all on table public.knowledge_marks from public, anon, authenticated;
revoke all on table public.problem_marks from public, anon, authenticated;
grant select on table public.canonical_subjects to authenticated;
grant select on table public.knowledge_marks to authenticated;
grant select on table public.problem_marks to authenticated;
grant all on table public.canonical_subjects to service_role;
grant all on table public.knowledge_marks to service_role;
grant all on table public.problem_marks to service_role;

create policy canonical_subjects_authenticated_select
  on public.canonical_subjects
for select to authenticated
using (true);

create policy knowledge_marks_authenticated_select
  on public.knowledge_marks
for select to authenticated
using (true);

create policy problem_marks_visible_problem_select
  on public.problem_marks
for select to authenticated
using (public.can_view_problem(problem_id));

revoke all on function public.sync_knowledge_registry(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_knowledge_registry(jsonb, jsonb)
  to service_role;
