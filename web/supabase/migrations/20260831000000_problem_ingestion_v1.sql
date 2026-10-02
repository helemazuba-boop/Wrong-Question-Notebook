-- Problem Ingestion v1
--
-- Provider output is retained as a versioned recognition document. It is not
-- the Problem row: page geometry, OCR regions, visual elements and student
-- handwriting remain ingestion evidence, while an accepted question is
-- normalized into the existing Problem shell consumed by review/attempts.

create table public.problem_ingestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete set null,
  schema_version text not null,
  provider text not null,
  provider_model text not null,
  status text not null,
  document jsonb not null,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  constraint problem_ingestions_schema_version_check
    check (schema_version = 'wqn.problem-ingestion.v1'),
  constraint problem_ingestions_status_check
    check (status in ('complete', 'partial')),
  constraint problem_ingestions_document_check
    check (
      jsonb_typeof(document) = 'object'
      and document ->> 'schema_version' = schema_version
      and document ->> 'status' = status
      and jsonb_typeof(document -> 'pages') = 'array'
      and jsonb_typeof(document -> 'regions') = 'array'
      and jsonb_typeof(document -> 'questions') = 'array'
    ),
  constraint problem_ingestions_provider_payload_check
    check (provider_payload is null or jsonb_typeof(provider_payload) = 'object')
);

create index problem_ingestions_owner_created_idx
  on public.problem_ingestions (user_id, created_at desc);

alter table public.problem_ingestions enable row level security;
revoke all on table public.problem_ingestions from anon, authenticated;
grant select, insert on table public.problem_ingestions to authenticated;
grant all on table public.problem_ingestions to service_role;

create policy problem_ingestions_owner_select
  on public.problem_ingestions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy problem_ingestions_owner_insert
  on public.problem_ingestions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      subject_id is null
      or exists (
        select 1
        from public.subjects s
        where s.id = subject_id and s.user_id = (select auth.uid())
      )
    )
  );

create table public.problem_ingestion_problem_links (
  ingestion_id uuid not null references public.problem_ingestions(id),
  question_id text not null,
  problem_id uuid not null references public.problems(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ingestion_id, question_id),
  constraint problem_ingestion_problem_links_problem_unique unique (problem_id),
  constraint problem_ingestion_problem_links_question_id_check
    check (length(question_id) between 1 and 64)
);

create index problem_ingestion_problem_links_owner_idx
  on public.problem_ingestion_problem_links (user_id, created_at desc);

alter table public.problem_ingestion_problem_links enable row level security;
revoke all on table public.problem_ingestion_problem_links from anon, authenticated;
grant select on table public.problem_ingestion_problem_links to authenticated;
grant all on table public.problem_ingestion_problem_links to service_role;

create policy problem_ingestion_problem_links_owner_select
  on public.problem_ingestion_problem_links
  for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.capture_problem_ingestion_link_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ingestion_id uuid;
  v_question_id text;
begin
  if not (new.source ? 'ingestion_id')
     and not (new.source ? 'ingestion_question_id') then
    return new;
  end if;
  if not (new.source ? 'ingestion_id')
     or not (new.source ? 'ingestion_question_id') then
    raise exception using
      errcode = '23514',
      message = 'INCOMPLETE_PROBLEM_INGESTION_LINK';
  end if;

  begin
    v_ingestion_id := (new.source ->> 'ingestion_id')::uuid;
  exception when others then
    raise exception using
      errcode = '23514',
      message = 'INVALID_PROBLEM_INGESTION_ID';
  end;
  v_question_id := new.source ->> 'ingestion_question_id';

  if not exists (
    select 1
    from public.problem_ingestions i
    cross join lateral jsonb_array_elements(i.document -> 'questions') q
    where i.id = v_ingestion_id
      and i.user_id = new.user_id
      and q ->> 'question_id' = v_question_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'UNKNOWN_PROBLEM_INGESTION_QUESTION';
  end if;

  insert into public.problem_ingestion_problem_links (
    ingestion_id, question_id, problem_id, user_id
  ) values (
    v_ingestion_id, v_question_id, new.id, new.user_id
  );
  return new;
end;
$$;

revoke all on function public.capture_problem_ingestion_link_v1() from public;

create trigger capture_problem_ingestion_link_v1
after insert on public.problems
for each row
execute function public.capture_problem_ingestion_link_v1();
