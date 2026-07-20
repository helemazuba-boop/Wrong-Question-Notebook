-- Word Pack v2: deterministic bounded content packages plus a monotonic
-- change feed with explicit tombstones. This is the W3 content checkpoint.

alter table public.word_packs
  drop constraint if exists word_packs_schema_version_check;
alter table public.word_packs
  add constraint word_packs_schema_version_check check (schema_version in (1, 2));

alter table public.word_decks
  drop constraint if exists word_decks_revision_check;
alter table public.word_decks
  add constraint word_decks_revision_check
  check (revision between 1 and 9007199254740991);

alter table public.word_entries
  drop constraint if exists word_entries_revision_check;
alter table public.word_entries
  add constraint word_entries_revision_check
  check (revision between 1 and 9007199254740991);

alter table public.word_packs
  drop constraint if exists word_packs_revision_check;
alter table public.word_packs
  add constraint word_packs_revision_check
  check (revision between 1 and 9007199254740991);

update storage.buckets
set file_size_limit = 4194304
where id = 'word-packs';

create table if not exists public.word_change_log (
  sequence bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  deck_id uuid not null,
  entity_kind text not null,
  entity_id uuid not null,
  operation text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint word_change_log_sequence_v1_check check (sequence between 1 and 9007199254740991),
  constraint word_change_log_entity_v1_check check (entity_kind in ('deck', 'entry', 'progress', 'pack')),
  constraint word_change_log_operation_v1_check check (operation in ('upsert', 'delete')),
  constraint word_change_log_payload_v1_check check (jsonb_typeof(payload) = 'object')
);

create index if not exists word_change_log_visible_v1_idx
  on public.word_change_log (user_id, sequence);
create index if not exists word_change_log_deck_v1_idx
  on public.word_change_log (deck_id, sequence desc);

alter table public.word_change_log enable row level security;
revoke all on table public.word_change_log from anon, authenticated;
grant all on table public.word_change_log to service_role;

create or replace function public.log_word_change_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deck_id uuid;
  v_entity_id uuid;
  v_user_id uuid;
  v_title text;
  v_revision bigint;
  v_operation text := case when tg_op = 'DELETE' then 'delete' else 'upsert' end;
begin
  if tg_table_name = 'word_decks' then
    v_deck_id := coalesce(new.id, old.id);
    v_entity_id := v_deck_id;
    v_user_id := coalesce(new.user_id, old.user_id);
    v_title := coalesce(new.title, old.title);
    v_revision := coalesce(new.revision, old.revision, 1);
    if tg_op <> 'DELETE' and (new.is_active = false or new.archived_at is not null) then
      v_operation := 'delete';
    end if;
  elsif tg_table_name = 'word_entries' then
    v_deck_id := coalesce(new.deck_id, old.deck_id);
    v_entity_id := coalesce(new.id, old.id);
    select d.user_id, d.title, d.revision
      into v_user_id, v_title, v_revision
      from public.word_decks d
      where d.id = v_deck_id;
  elsif tg_table_name = 'word_progress' then
    v_entity_id := coalesce(new.id, old.id);
    v_user_id := coalesce(new.user_id, old.user_id);
    select e.deck_id, d.title, d.revision
      into v_deck_id, v_title, v_revision
      from public.word_entries e
      join public.word_decks d on d.id = e.deck_id
      where e.id = coalesce(new.word_entry_id, old.word_entry_id);
  elsif tg_table_name = 'word_packs' then
    v_deck_id := coalesce(new.deck_id, old.deck_id);
    v_entity_id := coalesce(new.id, old.id);
    select d.user_id, d.title, d.revision
      into v_user_id, v_title, v_revision
      from public.word_decks d
      where d.id = v_deck_id;
  end if;

  if v_deck_id is null or v_entity_id is null then
    return coalesce(new, old);
  end if;

  insert into public.word_change_log (
    user_id,
    deck_id,
    entity_kind,
    entity_id,
    operation,
    payload
  ) values (
    v_user_id,
    v_deck_id,
    case tg_table_name
      when 'word_decks' then 'deck'
      when 'word_entries' then 'entry'
      when 'word_progress' then 'progress'
      else 'pack'
    end,
    v_entity_id,
    v_operation,
    jsonb_build_object(
      'title', coalesce(v_title, ''),
      'content_revision', coalesce(v_revision, 1),
      'deleted', v_operation = 'delete'
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists log_word_deck_change_v1 on public.word_decks;
create trigger log_word_deck_change_v1
after insert or update or delete on public.word_decks
for each row execute function public.log_word_change_v1();

drop trigger if exists log_word_entry_change_v1 on public.word_entries;
create trigger log_word_entry_change_v1
after insert or update or delete on public.word_entries
for each row execute function public.log_word_change_v1();

drop trigger if exists log_word_progress_change_v1 on public.word_progress;
create trigger log_word_progress_change_v1
after insert or update or delete on public.word_progress
for each row execute function public.log_word_change_v1();

drop trigger if exists log_word_pack_change_v1 on public.word_packs;
create trigger log_word_pack_change_v1
after insert or update or delete on public.word_packs
for each row execute function public.log_word_change_v1();

-- Seed a visible baseline so cursor=0 can discover decks created before this
-- migration. System decks use NULL user_id and are visible to every user.
insert into public.word_change_log (
  user_id,
  deck_id,
  entity_kind,
  entity_id,
  operation,
  payload
)
select
  d.user_id,
  d.id,
  'deck',
  d.id,
  case when d.is_active and d.archived_at is null then 'upsert' else 'delete' end,
  jsonb_build_object(
    'title', d.title,
    'content_revision', d.revision,
    'deleted', not d.is_active or d.archived_at is not null
  )
from public.word_decks d;
