create table if not exists public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  title text not null,
  description text,
  color text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint notebooks_title_check check (char_length(title) between 1 and 80),
  constraint notebooks_description_check check (description is null or char_length(description) <= 1000)
);

create table if not exists public.notebook_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  title text not null,
  content text not null,
  source text not null default 'user',
  linked_problem_id uuid references public.problems(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint notebook_notes_title_check check (char_length(title) between 1 and 120),
  constraint notebook_notes_content_check check (char_length(content) between 1 and 4000),
  constraint notebook_notes_source_check check (source in ('user', 'ai', 'import'))
);

create table if not exists public.notebook_ai_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  can_read boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, notebook_id)
);

alter table public.notebooks enable row level security;
alter table public.notebook_notes enable row level security;
alter table public.notebook_ai_access enable row level security;

create index if not exists idx_notebooks_user_subject on public.notebooks(user_id, subject_id);
create index if not exists idx_notebooks_user_updated on public.notebooks(user_id, updated_at desc);
create index if not exists idx_notebooks_user_active on public.notebooks(user_id) where archived_at is null;
create index if not exists idx_notebook_notes_user_notebook_updated on public.notebook_notes(user_id, notebook_id, updated_at desc);
create index if not exists idx_notebook_notes_linked_problem on public.notebook_notes(linked_problem_id) where linked_problem_id is not null;
create index if not exists idx_notebook_ai_access_user_notebook on public.notebook_ai_access(user_id, notebook_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_notebooks_updated_at on public.notebooks;
create trigger set_notebooks_updated_at
before update on public.notebooks
for each row execute function public.set_updated_at();

drop trigger if exists set_notebook_notes_updated_at on public.notebook_notes;
create trigger set_notebook_notes_updated_at
before update on public.notebook_notes
for each row execute function public.set_updated_at();

drop trigger if exists set_notebook_ai_access_updated_at on public.notebook_ai_access;
create trigger set_notebook_ai_access_updated_at
before update on public.notebook_ai_access
for each row execute function public.set_updated_at();

drop policy if exists notebooks_owner_select on public.notebooks;
create policy notebooks_owner_select on public.notebooks
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists notebooks_owner_insert on public.notebooks;
create policy notebooks_owner_insert on public.notebooks
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.subjects s
    where s.id = subject_id and s.user_id = (select auth.uid())
  )
);

drop policy if exists notebooks_owner_update on public.notebooks;
create policy notebooks_owner_update on public.notebooks
for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.subjects s
    where s.id = subject_id and s.user_id = (select auth.uid())
  )
);

drop policy if exists notebooks_owner_delete on public.notebooks;
create policy notebooks_owner_delete on public.notebooks
for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists notebook_notes_owner_select on public.notebook_notes;
create policy notebook_notes_owner_select on public.notebook_notes
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists notebook_notes_owner_insert on public.notebook_notes;
create policy notebook_notes_owner_insert on public.notebook_notes
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.notebooks n
    where n.id = notebook_id and n.user_id = (select auth.uid())
  )
  and (
    linked_problem_id is null
    or exists (
      select 1 from public.problems p
      where p.id = linked_problem_id and p.user_id = (select auth.uid())
    )
  )
);

drop policy if exists notebook_notes_owner_update on public.notebook_notes;
create policy notebook_notes_owner_update on public.notebook_notes
for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.notebooks n
    where n.id = notebook_id and n.user_id = (select auth.uid())
  )
  and (
    linked_problem_id is null
    or exists (
      select 1 from public.problems p
      where p.id = linked_problem_id and p.user_id = (select auth.uid())
    )
  )
);

drop policy if exists notebook_notes_owner_delete on public.notebook_notes;
create policy notebook_notes_owner_delete on public.notebook_notes
for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists notebook_ai_access_owner_select on public.notebook_ai_access;
create policy notebook_ai_access_owner_select on public.notebook_ai_access
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists notebook_ai_access_owner_insert on public.notebook_ai_access;
create policy notebook_ai_access_owner_insert on public.notebook_ai_access
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.notebooks n
    where n.id = notebook_id and n.user_id = (select auth.uid())
  )
);

drop policy if exists notebook_ai_access_owner_update on public.notebook_ai_access;
create policy notebook_ai_access_owner_update on public.notebook_ai_access
for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.notebooks n
    where n.id = notebook_id and n.user_id = (select auth.uid())
  )
);

drop policy if exists notebook_ai_access_owner_delete on public.notebook_ai_access;
create policy notebook_ai_access_owner_delete on public.notebook_ai_access
for delete to authenticated
using ((select auth.uid()) = user_id);
