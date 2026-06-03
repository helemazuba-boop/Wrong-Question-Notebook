create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'pending',
  priority text not null default 'normal',
  due_at timestamptz,
  reminder_at timestamptz,
  subject_id uuid references public.subjects(id) on delete set null,
  problem_set_id uuid references public.problem_sets(id) on delete set null,
  problem_id uuid references public.problems(id) on delete set null,
  notebook_id uuid references public.notebooks(id) on delete set null,
  note_id uuid references public.notebook_notes(id) on delete set null,
  source text not null default 'manual',
  created_by text not null default 'user',
  source_conversation_id text,
  source_device_id uuid references public.esp32_devices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  archived_at timestamptz,
  constraint todos_title_check check (char_length(title) between 1 and 120),
  constraint todos_description_check check (description is null or char_length(description) <= 2000),
  constraint todos_status_check check (status in ('pending', 'completed', 'cancelled')),
  constraint todos_priority_check check (priority in ('low', 'normal', 'high')),
  constraint todos_source_check check (source in ('manual', 'ai', 'device', 'system')),
  constraint todos_created_by_check check (created_by in ('user', 'ai', 'device', 'system'))
);

alter table public.todos enable row level security;

create index if not exists idx_todos_user_status_due on public.todos(user_id, status, due_at nulls last);
create index if not exists idx_todos_user_updated on public.todos(user_id, updated_at desc);
create index if not exists idx_todos_user_subject on public.todos(user_id, subject_id) where subject_id is not null;
create index if not exists idx_todos_user_problem on public.todos(user_id, problem_id) where problem_id is not null;
create index if not exists idx_todos_user_notebook on public.todos(user_id, notebook_id) where notebook_id is not null;
create index if not exists idx_todos_user_active on public.todos(user_id) where archived_at is null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_todos_updated_at on public.todos;
create trigger set_todos_updated_at
before update on public.todos
for each row execute function public.set_updated_at();

drop policy if exists todos_owner_select on public.todos;
create policy todos_owner_select on public.todos
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists todos_owner_insert on public.todos;
create policy todos_owner_insert on public.todos
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and (
    subject_id is null
    or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = (select auth.uid())
    )
  )
  and (
    problem_set_id is null
    or exists (
      select 1 from public.problem_sets ps
      where ps.id = problem_set_id and ps.user_id = (select auth.uid())
    )
  )
  and (
    problem_id is null
    or exists (
      select 1 from public.problems p
      where p.id = problem_id and p.user_id = (select auth.uid())
    )
  )
  and (
    notebook_id is null
    or exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = (select auth.uid())
    )
  )
  and (
    note_id is null
    or exists (
      select 1 from public.notebook_notes nn
      where nn.id = note_id and nn.user_id = (select auth.uid())
    )
  )
);

drop policy if exists todos_owner_update on public.todos;
create policy todos_owner_update on public.todos
for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and (
    subject_id is null
    or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = (select auth.uid())
    )
  )
  and (
    problem_set_id is null
    or exists (
      select 1 from public.problem_sets ps
      where ps.id = problem_set_id and ps.user_id = (select auth.uid())
    )
  )
  and (
    problem_id is null
    or exists (
      select 1 from public.problems p
      where p.id = problem_id and p.user_id = (select auth.uid())
    )
  )
  and (
    notebook_id is null
    or exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = (select auth.uid())
    )
  )
  and (
    note_id is null
    or exists (
      select 1 from public.notebook_notes nn
      where nn.id = note_id and nn.user_id = (select auth.uid())
    )
  )
);

drop policy if exists todos_owner_delete on public.todos;
create policy todos_owner_delete on public.todos
for delete to authenticated
using ((select auth.uid()) = user_id);
