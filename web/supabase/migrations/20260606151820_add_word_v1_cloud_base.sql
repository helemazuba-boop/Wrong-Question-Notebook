alter table public.problem_sets
  add column if not exists type text not null default 'manual';

alter table public.problem_sets
  drop constraint if exists problem_sets_type_check;

alter table public.problem_sets
  add constraint problem_sets_type_check
  check (type in ('manual', 'word_mistakes'));

create unique index if not exists idx_problem_sets_user_word_mistakes
  on public.problem_sets(user_id)
  where type = 'word_mistakes';

create table if not exists public.word_decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  description text,
  source text not null default 'system',
  language text not null default 'en',
  target_language text not null default 'zh-CN',
  is_system boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint word_decks_title_check check (char_length(title) between 1 and 80),
  constraint word_decks_description_check check (description is null or char_length(description) <= 500),
  constraint word_decks_source_check check (source in ('system', 'user', 'import', 'ai')),
  constraint word_decks_language_check check (char_length(language) between 1 and 16),
  constraint word_decks_target_language_check check (char_length(target_language) between 1 and 16),
  constraint word_decks_revision_check check (revision >= 1),
  constraint word_decks_system_ownership_check check (
    (
      source = 'system'
      and is_system = true
      and user_id is null
    )
    or (
      source <> 'system'
      and is_system = false
      and user_id is not null
    )
  )
);

create table if not exists public.word_entries (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.word_decks(id) on delete cascade,
  word text not null,
  normalized_word text not null,
  phonetic text,
  meaning text not null,
  example text,
  example_translation text,
  part_of_speech text,
  tags text[] not null default '{}',
  sort_index integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deck_id, normalized_word),
  constraint word_entries_word_check check (char_length(word) between 1 and 80),
  constraint word_entries_normalized_word_check check (
    char_length(normalized_word) between 1 and 80
    and normalized_word = lower(btrim(normalized_word))
  ),
  constraint word_entries_meaning_check check (char_length(meaning) between 1 and 1000),
  constraint word_entries_example_check check (example is null or char_length(example) <= 1000),
  constraint word_entries_example_translation_check check (
    example_translation is null or char_length(example_translation) <= 1000
  ),
  constraint word_entries_part_of_speech_check check (
    part_of_speech is null or char_length(part_of_speech) <= 64
  ),
  constraint word_entries_revision_check check (revision >= 1)
);

create table if not exists public.word_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  status text not null default 'new',
  due_at timestamptz,
  last_reviewed_at timestamptz,
  interval_days integer not null default 0,
  correct_streak integer not null default 0,
  lapses integer not null default 0,
  reviewed_count integer not null default 0,
  known_count integer not null default 0,
  unknown_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, word_entry_id),
  constraint word_progress_status_check check (status in ('new', 'learning', 'review', 'mastered')),
  constraint word_progress_interval_days_check check (interval_days between 0 and 180),
  constraint word_progress_correct_streak_check check (correct_streak >= 0),
  constraint word_progress_lapses_check check (lapses >= 0),
  constraint word_progress_reviewed_count_check check (reviewed_count >= 0),
  constraint word_progress_known_count_check check (known_count >= 0),
  constraint word_progress_unknown_count_check check (unknown_count >= 0)
);

create table if not exists public.word_deck_ai_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  deck_id uuid not null references public.word_decks(id) on delete cascade,
  can_read boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, deck_id)
);

create table if not exists public.word_review_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  outcome text not null,
  mode text not null,
  source text not null default 'web',
  device_id uuid references public.esp32_devices(id) on delete set null,
  conversation_id text,
  wrong_problem_id uuid references public.problems(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint word_review_events_outcome_check check (outcome in ('known', 'unknown', 'skip')),
  constraint word_review_events_mode_check check (mode in ('sequential', 'random', 'dictionary')),
  constraint word_review_events_source_check check (source in ('web', 'device', 'ai', 'system')),
  constraint word_review_events_conversation_id_check check (
    conversation_id is null or char_length(conversation_id) <= 128
  )
);

create table if not exists public.word_mistake_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_entry_id uuid not null references public.word_entries(id) on delete cascade,
  problem_set_id uuid not null references public.problem_sets(id) on delete cascade,
  problem_id uuid not null references public.problems(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, word_entry_id)
);

alter table public.word_decks enable row level security;
alter table public.word_entries enable row level security;
alter table public.word_progress enable row level security;
alter table public.word_deck_ai_access enable row level security;
alter table public.word_review_events enable row level security;
alter table public.word_mistake_links enable row level security;

grant select on table public.word_decks to authenticated;
grant insert, update, delete on table public.word_decks to authenticated;
grant select on table public.word_entries to authenticated;
grant insert, update, delete on table public.word_entries to authenticated;
grant select, insert, update, delete on table public.word_progress to authenticated;
grant select, insert, update, delete on table public.word_deck_ai_access to authenticated;
grant select, insert on table public.word_review_events to authenticated;
grant select, insert, update, delete on table public.word_mistake_links to authenticated;
grant all on table public.word_decks to service_role;
grant all on table public.word_entries to service_role;
grant all on table public.word_progress to service_role;
grant all on table public.word_deck_ai_access to service_role;
grant all on table public.word_review_events to service_role;
grant all on table public.word_mistake_links to service_role;

create index if not exists idx_word_decks_visible
  on public.word_decks(is_system, user_id, updated_at desc)
  where is_active = true and archived_at is null;

create index if not exists idx_word_decks_user_updated
  on public.word_decks(user_id, updated_at desc)
  where user_id is not null;

create index if not exists idx_word_entries_deck_sort
  on public.word_entries(deck_id, sort_index, normalized_word);

create index if not exists idx_word_entries_normalized
  on public.word_entries(normalized_word);

create index if not exists idx_word_entries_deck_updated
  on public.word_entries(deck_id, updated_at desc);

create index if not exists idx_word_progress_user_due
  on public.word_progress(user_id, due_at nulls first, status);

create index if not exists idx_word_progress_user_entry
  on public.word_progress(user_id, word_entry_id);

create index if not exists idx_word_deck_ai_access_user_deck
  on public.word_deck_ai_access(user_id, deck_id);

create index if not exists idx_word_review_events_user_created
  on public.word_review_events(user_id, created_at desc);

create index if not exists idx_word_review_events_entry_created
  on public.word_review_events(word_entry_id, created_at desc);

create index if not exists idx_word_mistake_links_user_set
  on public.word_mistake_links(user_id, problem_set_id);

create index if not exists idx_word_mistake_links_problem
  on public.word_mistake_links(problem_id);

create or replace function public.word_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.word_deck_before_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();

  if new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.source is distinct from old.source
    or new.language is distinct from old.language
    or new.target_language is distinct from old.target_language
    or new.is_system is distinct from old.is_system
    or new.is_active is distinct from old.is_active
    or new.metadata is distinct from old.metadata
    or new.archived_at is distinct from old.archived_at then
    new.revision = old.revision + 1;
  end if;

  return new;
end;
$$;

create or replace function public.word_entry_before_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();

  if new.word is distinct from old.word
    or new.normalized_word is distinct from old.normalized_word
    or new.phonetic is distinct from old.phonetic
    or new.meaning is distinct from old.meaning
    or new.example is distinct from old.example
    or new.example_translation is distinct from old.example_translation
    or new.part_of_speech is distinct from old.part_of_speech
    or new.tags is distinct from old.tags
    or new.sort_index is distinct from old.sort_index
    or new.metadata is distinct from old.metadata then
    new.revision = old.revision + 1;
  end if;

  return new;
end;
$$;

create or replace function public.word_bump_deck_revision_for_entry()
returns trigger
language plpgsql
as $$
declare
  affected_deck_id uuid;
begin
  affected_deck_id = coalesce(new.deck_id, old.deck_id);

  update public.word_decks
  set revision = revision + 1,
      updated_at = now()
  where id = affected_deck_id;

  if tg_op = 'UPDATE' and old.deck_id is distinct from new.deck_id then
    update public.word_decks
    set revision = revision + 1,
        updated_at = now()
    where id = old.deck_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists set_word_decks_updated_at on public.word_decks;
create trigger set_word_decks_updated_at
before update on public.word_decks
for each row execute function public.word_deck_before_update();

drop trigger if exists set_word_entries_updated_at on public.word_entries;
create trigger set_word_entries_updated_at
before update on public.word_entries
for each row execute function public.word_entry_before_update();

drop trigger if exists bump_word_deck_revision_after_entry_change on public.word_entries;
create trigger bump_word_deck_revision_after_entry_change
after insert or update or delete on public.word_entries
for each row execute function public.word_bump_deck_revision_for_entry();

drop trigger if exists set_word_progress_updated_at on public.word_progress;
create trigger set_word_progress_updated_at
before update on public.word_progress
for each row execute function public.word_touch_updated_at();

drop trigger if exists set_word_deck_ai_access_updated_at on public.word_deck_ai_access;
create trigger set_word_deck_ai_access_updated_at
before update on public.word_deck_ai_access
for each row execute function public.word_touch_updated_at();

drop trigger if exists set_word_mistake_links_updated_at on public.word_mistake_links;
create trigger set_word_mistake_links_updated_at
before update on public.word_mistake_links
for each row execute function public.word_touch_updated_at();

drop policy if exists word_decks_visible_select on public.word_decks;
create policy word_decks_visible_select on public.word_decks
for select to authenticated
using (
  is_active = true
  and archived_at is null
  and (
    is_system = true
    or user_id = (select auth.uid())
  )
);

drop policy if exists word_decks_owner_insert on public.word_decks;
create policy word_decks_owner_insert on public.word_decks
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and source in ('user', 'import', 'ai')
  and is_system = false
);

drop policy if exists word_decks_owner_update on public.word_decks;
create policy word_decks_owner_update on public.word_decks
for update to authenticated
using (
  user_id = (select auth.uid())
  and is_system = false
)
with check (
  user_id = (select auth.uid())
  and source in ('user', 'import', 'ai')
  and is_system = false
);

drop policy if exists word_decks_owner_delete on public.word_decks;
create policy word_decks_owner_delete on public.word_decks
for delete to authenticated
using (
  user_id = (select auth.uid())
  and is_system = false
);

drop policy if exists word_entries_visible_select on public.word_entries;
create policy word_entries_visible_select on public.word_entries
for select to authenticated
using (
  exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.is_active = true
      and d.archived_at is null
      and (
        d.is_system = true
        or d.user_id = (select auth.uid())
      )
  )
);

drop policy if exists word_entries_owner_insert on public.word_entries;
create policy word_entries_owner_insert on public.word_entries
for insert to authenticated
with check (
  exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.is_active = true
      and d.archived_at is null
  )
);

drop policy if exists word_entries_owner_update on public.word_entries;
create policy word_entries_owner_update on public.word_entries
for update to authenticated
using (
  exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.archived_at is null
  )
)
with check (
  exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.archived_at is null
  )
);

drop policy if exists word_entries_owner_delete on public.word_entries;
create policy word_entries_owner_delete on public.word_entries
for delete to authenticated
using (
  exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.archived_at is null
  )
);

drop policy if exists word_progress_owner_select on public.word_progress;
create policy word_progress_owner_select on public.word_progress
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_progress_owner_insert on public.word_progress;
create policy word_progress_owner_insert on public.word_progress
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.word_entries e
    join public.word_decks d on d.id = e.deck_id
    where e.id = word_entry_id
      and d.is_active = true
      and d.archived_at is null
      and (
        d.is_system = true
        or d.user_id = (select auth.uid())
      )
  )
);

drop policy if exists word_progress_owner_update on public.word_progress;
create policy word_progress_owner_update on public.word_progress
for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.word_entries e
    join public.word_decks d on d.id = e.deck_id
    where e.id = word_entry_id
      and d.is_active = true
      and d.archived_at is null
      and (
        d.is_system = true
        or d.user_id = (select auth.uid())
      )
  )
);

drop policy if exists word_progress_owner_delete on public.word_progress;
create policy word_progress_owner_delete on public.word_progress
for delete to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_deck_ai_access_owner_select on public.word_deck_ai_access;
create policy word_deck_ai_access_owner_select on public.word_deck_ai_access
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_deck_ai_access_owner_insert on public.word_deck_ai_access;
create policy word_deck_ai_access_owner_insert on public.word_deck_ai_access
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.archived_at is null
  )
);

drop policy if exists word_deck_ai_access_owner_update on public.word_deck_ai_access;
create policy word_deck_ai_access_owner_update on public.word_deck_ai_access
for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.word_decks d
    where d.id = deck_id
      and d.user_id = (select auth.uid())
      and d.is_system = false
      and d.source <> 'system'
      and d.archived_at is null
  )
);

drop policy if exists word_deck_ai_access_owner_delete on public.word_deck_ai_access;
create policy word_deck_ai_access_owner_delete on public.word_deck_ai_access
for delete to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_review_events_owner_select on public.word_review_events;
create policy word_review_events_owner_select on public.word_review_events
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_review_events_owner_insert on public.word_review_events;
create policy word_review_events_owner_insert on public.word_review_events
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.word_entries e
    join public.word_decks d on d.id = e.deck_id
    where e.id = word_entry_id
      and d.is_active = true
      and d.archived_at is null
      and (
        d.is_system = true
        or d.user_id = (select auth.uid())
      )
  )
);

drop policy if exists word_mistake_links_owner_select on public.word_mistake_links;
create policy word_mistake_links_owner_select on public.word_mistake_links
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists word_mistake_links_owner_insert on public.word_mistake_links;
create policy word_mistake_links_owner_insert on public.word_mistake_links
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.word_entries e
    join public.word_decks d on d.id = e.deck_id
    where e.id = word_entry_id
      and d.is_active = true
      and d.archived_at is null
      and (
        d.is_system = true
        or d.user_id = (select auth.uid())
      )
  )
  and exists (
    select 1
    from public.problem_sets ps
    where ps.id = problem_set_id
      and ps.user_id = (select auth.uid())
      and ps.type = 'word_mistakes'
  )
  and exists (
    select 1
    from public.problems p
    where p.id = problem_id
      and p.user_id = (select auth.uid())
  )
);

drop policy if exists word_mistake_links_owner_update on public.word_mistake_links;
create policy word_mistake_links_owner_update on public.word_mistake_links
for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.problem_sets ps
    where ps.id = problem_set_id
      and ps.user_id = (select auth.uid())
      and ps.type = 'word_mistakes'
  )
  and exists (
    select 1
    from public.problems p
    where p.id = problem_id
      and p.user_id = (select auth.uid())
  )
);

drop policy if exists word_mistake_links_owner_delete on public.word_mistake_links;
create policy word_mistake_links_owner_delete on public.word_mistake_links
for delete to authenticated
using (user_id = (select auth.uid()));
