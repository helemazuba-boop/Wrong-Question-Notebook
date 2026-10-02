-- Problem Ingestion workspace v1
--
-- Recognition documents remain immutable evidence. This table tracks the
-- user workflow for each recognized question: a stable future Problem ID,
-- ordered attachments, and whether the candidate is pending, skipped or
-- accepted. The product workflow accepts at most 20 independent questions;
-- the broader provider-neutral document schema keeps its defensive ceiling.

create table public.problem_ingestion_candidates (
  ingestion_id uuid not null
    references public.problem_ingestions(id) on delete cascade,
  question_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  position smallint not null,
  problem_id uuid not null default gen_random_uuid(),
  status text not null default 'pending',
  assets jsonb not null default '[]'::jsonb,
  solution_assets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ingestion_id, question_id),
  constraint problem_ingestion_candidates_problem_unique unique (problem_id),
  constraint problem_ingestion_candidates_position_check
    check (position between 1 and 20),
  constraint problem_ingestion_candidates_question_id_check
    check (length(question_id) between 1 and 64),
  constraint problem_ingestion_candidates_status_check
    check (status in ('pending', 'skipped', 'accepted')),
  constraint problem_ingestion_candidates_assets_check
    check (
      jsonb_typeof(assets) = 'array'
      and jsonb_array_length(assets) <= 20
      and jsonb_typeof(solution_assets) = 'array'
      and jsonb_array_length(solution_assets) <= 20
    )
);

create index problem_ingestion_candidates_owner_updated_idx
  on public.problem_ingestion_candidates (user_id, updated_at desc);

alter table public.problem_ingestion_candidates enable row level security;
revoke all on table public.problem_ingestion_candidates from anon, authenticated;
grant select on table public.problem_ingestion_candidates to authenticated;
grant update (assets, solution_assets, status, updated_at)
  on table public.problem_ingestion_candidates to authenticated;

create policy problem_ingestion_candidates_owner_select
  on public.problem_ingestion_candidates
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy problem_ingestion_candidates_owner_update
  on public.problem_ingestion_candidates
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- A workspace may be discarded only while no accepted Problem link exists;
-- the existing link FK uses RESTRICT and protects accepted evidence.
grant delete on table public.problem_ingestions to authenticated;
create policy problem_ingestions_owner_delete
  on public.problem_ingestions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.initialize_problem_ingestion_candidates_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_question_count integer;
begin
  v_question_count := jsonb_array_length(new.document -> 'questions');
  if v_question_count < 1 then
    raise exception using
      errcode = '23514',
      message = 'PROBLEM_INGESTION_HAS_NO_QUESTIONS';
  end if;
  if v_question_count > 20 then
    raise exception using
      errcode = '23514',
      message = 'PROBLEM_INGESTION_QUESTION_LIMIT_EXCEEDED';
  end if;

  insert into public.problem_ingestion_candidates (
    ingestion_id,
    question_id,
    user_id,
    position
  )
  select
    new.id,
    question.value ->> 'question_id',
    new.user_id,
    question.ordinality::smallint
  from jsonb_array_elements(new.document -> 'questions')
    with ordinality as question(value, ordinality);

  return new;
end;
$$;

revoke all on function public.initialize_problem_ingestion_candidates_v1()
  from public;

create trigger initialize_problem_ingestion_candidates_v1
after insert on public.problem_ingestions
for each row
execute function public.initialize_problem_ingestion_candidates_v1();

-- Accepted is an objective state: it is legal only after the existing
-- Problem-link trigger has recorded the exact preallocated Problem ID.
create or replace function public.guard_problem_ingestion_candidate_update_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_asset jsonb;
  v_path text;
  v_prefix text;
  v_suffix text;
begin
  if old.status = 'accepted' then
    raise exception using
      errcode = '23514',
      message = 'ACCEPTED_PROBLEM_INGESTION_CANDIDATE_IS_IMMUTABLE';
  end if;

  if jsonb_typeof(new.assets) <> 'array'
     or jsonb_typeof(new.solution_assets) <> 'array' then
    raise exception using
      errcode = '23514',
      message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET';
  end if;

  v_prefix := 'user/' || new.user_id || '/problems/' || new.problem_id ||
    '/problem/';
  for v_asset in select value from jsonb_array_elements(new.assets)
  loop
    if jsonb_typeof(v_asset) <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET';
    end if;
    if not (v_asset ?& array['path', 'name', 'part_id'])
       or exists (
         select 1
         from jsonb_object_keys(v_asset) key
         where key not in ('path', 'name', 'part_id')
       )
       or jsonb_typeof(v_asset -> 'path') <> 'string'
       or jsonb_typeof(v_asset -> 'name') <> 'string'
       or not (
         v_asset -> 'part_id' = 'null'::jsonb
         or (
           jsonb_typeof(v_asset -> 'part_id') = 'string'
           and length(v_asset ->> 'part_id') between 1 and 64
         )
       ) then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET';
    end if;
    v_path := v_asset ->> 'path';
    v_suffix := substring(v_path from length(v_prefix) + 1);
    if left(v_path, length(v_prefix)) <> v_prefix
       or length(v_suffix) < 1
       or position('/' in v_suffix) > 0
       or length(v_path) > 1000
       or length(v_asset ->> 'name') not between 1 and 255 then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET_PATH';
    end if;
  end loop;
  if (
    select count(*) <> count(distinct value ->> 'path')
    from jsonb_array_elements(new.assets)
  ) then
    raise exception using
      errcode = '23514',
      message = 'DUPLICATE_PROBLEM_INGESTION_CANDIDATE_ASSET_PATH';
  end if;

  v_prefix := 'user/' || new.user_id || '/problems/' || new.problem_id ||
    '/solution/';
  for v_asset in select value from jsonb_array_elements(new.solution_assets)
  loop
    if jsonb_typeof(v_asset) <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET';
    end if;
    if not (v_asset ?& array['path', 'name', 'part_id'])
       or exists (
         select 1
         from jsonb_object_keys(v_asset) key
         where key not in ('path', 'name', 'part_id')
       )
       or jsonb_typeof(v_asset -> 'path') <> 'string'
       or jsonb_typeof(v_asset -> 'name') <> 'string'
       or not (
         v_asset -> 'part_id' = 'null'::jsonb
         or (
           jsonb_typeof(v_asset -> 'part_id') = 'string'
           and length(v_asset ->> 'part_id') between 1 and 64
         )
       ) then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET';
    end if;
    v_path := v_asset ->> 'path';
    v_suffix := substring(v_path from length(v_prefix) + 1);
    if left(v_path, length(v_prefix)) <> v_prefix
       or length(v_suffix) < 1
       or position('/' in v_suffix) > 0
       or length(v_path) > 1000
       or length(v_asset ->> 'name') not between 1 and 255 then
      raise exception using
        errcode = '23514',
        message = 'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET_PATH';
    end if;
  end loop;
  if (
    select count(*) <> count(distinct value ->> 'path')
    from jsonb_array_elements(new.solution_assets)
  ) then
    raise exception using
      errcode = '23514',
      message = 'DUPLICATE_PROBLEM_INGESTION_CANDIDATE_ASSET_PATH';
  end if;

  if new.status = 'accepted' and old.status <> 'accepted' and not exists (
    select 1
    from public.problem_ingestion_problem_links link
    where link.ingestion_id = new.ingestion_id
      and link.question_id = new.question_id
      and link.problem_id = new.problem_id
      and link.user_id = new.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'PROBLEM_INGESTION_CANDIDATE_HAS_NO_PROBLEM_LINK';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.guard_problem_ingestion_candidate_update_v1()
  from public;

create trigger guard_problem_ingestion_candidate_update_v1
before update on public.problem_ingestion_candidates
for each row
execute function public.guard_problem_ingestion_candidate_update_v1();

-- Backfill still-open documents created between the v1 contract migration and
-- this workspace migration. Documents outside the product limit remain valid
-- evidence but require manual splitting instead of silent truncation.
insert into public.problem_ingestion_candidates (
  ingestion_id,
  question_id,
  user_id,
  position
)
select
  ingestion.id,
  question.value ->> 'question_id',
  ingestion.user_id,
  question.ordinality::smallint
from public.problem_ingestions ingestion
cross join lateral jsonb_array_elements(ingestion.document -> 'questions')
  with ordinality as question(value, ordinality)
where jsonb_array_length(ingestion.document -> 'questions') between 1 and 20
on conflict (ingestion_id, question_id) do nothing;
