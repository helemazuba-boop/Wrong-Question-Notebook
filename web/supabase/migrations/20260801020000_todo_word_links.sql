-- Let one Todo point at the same Word resources used by Web, MCP and Note4.
-- The links are nullable so existing notebook/problem Todo workflows remain
-- unchanged.

alter table public.todos
  add column if not exists word_deck_id uuid
    references public.word_decks(id) on delete set null,
  add column if not exists word_entry_id uuid
    references public.word_entries(id) on delete set null;

create index if not exists idx_todos_user_word_deck
  on public.todos(user_id, word_deck_id)
  where word_deck_id is not null;
create index if not exists idx_todos_user_word_entry
  on public.todos(user_id, word_entry_id)
  where word_entry_id is not null;

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
  and (
    word_deck_id is null
    or exists (
      select 1 from public.word_decks d
      where d.id = word_deck_id
        and d.is_active = true
        and (d.user_id = (select auth.uid()) or d.is_system = true)
    )
  )
  and (
    word_entry_id is null
    or exists (
      select 1
      from public.word_entries e
      join public.word_decks d on d.id = e.deck_id
      where e.id = word_entry_id
        and d.is_active = true
        and (d.user_id = (select auth.uid()) or d.is_system = true)
    )
  )
  and (
    word_entry_id is null
    or word_deck_id is null
    or exists (
      select 1 from public.word_entries e
      where e.id = word_entry_id and e.deck_id = word_deck_id
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
  and (
    word_deck_id is null
    or exists (
      select 1 from public.word_decks d
      where d.id = word_deck_id
        and d.is_active = true
        and (d.user_id = (select auth.uid()) or d.is_system = true)
    )
  )
  and (
    word_entry_id is null
    or exists (
      select 1
      from public.word_entries e
      join public.word_decks d on d.id = e.deck_id
      where e.id = word_entry_id
        and d.is_active = true
        and (d.user_id = (select auth.uid()) or d.is_system = true)
    )
  )
  and (
    word_entry_id is null
    or word_deck_id is null
    or exists (
      select 1 from public.word_entries e
      where e.id = word_entry_id and e.deck_id = word_deck_id
    )
  )
);
