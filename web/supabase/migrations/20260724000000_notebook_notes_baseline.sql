-- Blank-notebook N0 baseline: stable ordering, frozen content format, and a
-- monotonic per-user change feed with tombstones for device sync.
--
-- Additive and idempotent: brings existing installations forward without
-- rewriting migration history, and re-running is a no-op.

-- 1. Frozen content format ---------------------------------------------------
-- Every note now records the format its bytes conform to. v1 is plain_text_v1.
alter table public.notebook_notes
  add column if not exists content_format text not null default 'plain_text_v1';

alter table public.notebook_notes drop constraint if exists notebook_notes_content_format_check;
alter table public.notebook_notes
  add constraint notebook_notes_content_format_check
  check (content_format in ('plain_text_v1'));

-- UTF-8 byte guardrail. 16384 == 4000 chars * 4 bytes, a strict superset of the
-- existing char_length(content) <= 4000 constraint, so no currently-valid row
-- can violate it while pathological multibyte input is still bounded.
alter table public.notebook_notes drop constraint if exists notebook_notes_content_bytes_check;
alter table public.notebook_notes
  add constraint notebook_notes_content_bytes_check
  check (octet_length(content) <= 16384);

-- 2. Stable ordering ---------------------------------------------------------
-- sort_index gives notes a stable order inside a notebook that does not depend
-- on updated_at (which reorders on every edit).
alter table public.notebook_notes
  add column if not exists sort_index bigint;

-- Backfill existing rows deterministically by creation order within a notebook.
update public.notebook_notes n
set sort_index = ranked.rn
from (
  select id,
         row_number() over (partition by notebook_id order by created_at, id) as rn
  from public.notebook_notes
  where sort_index is null
) ranked
where n.id = ranked.id
  and n.sort_index is null;

-- New rows receive the next per-notebook index via a BEFORE INSERT trigger.
create or replace function public.assign_notebook_note_sort_index()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sort_index is null then
    -- Serialize sort_index assignment per notebook so concurrent inserts do not
    -- collide on the same index.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('notebook-note-sort:' || new.notebook_id::text, 0::bigint)
    );
    select coalesce(max(sort_index), 0) + 1
      into new.sort_index
      from public.notebook_notes
      where notebook_id = new.notebook_id;
  end if;
  return new;
end;
$$;

drop trigger if exists assign_notebook_note_sort_index on public.notebook_notes;
create trigger assign_notebook_note_sort_index
before insert on public.notebook_notes
for each row execute function public.assign_notebook_note_sort_index();

alter table public.notebook_notes alter column sort_index set not null;

create index if not exists idx_notebook_notes_notebook_sort
  on public.notebook_notes (notebook_id, sort_index, id)
  where archived_at is null;
create index if not exists idx_notebook_notes_notebook_title
  on public.notebook_notes (notebook_id, title, id)
  where archived_at is null;

-- 3. Search index ------------------------------------------------------------
-- Trigram GIN indexes accelerate the case-insensitive ilike search the service
-- performs on title and content. pg_trgm lives in the extensions schema on
-- Supabase; the operator class is schema-qualified so index creation does not
-- depend on the session search_path.
create extension if not exists pg_trgm with schema extensions;
create index if not exists idx_notebook_notes_title_trgm
  on public.notebook_notes using gin (title extensions.gin_trgm_ops);
create index if not exists idx_notebook_notes_content_trgm
  on public.notebook_notes using gin (content extensions.gin_trgm_ops);

-- 4. Create idempotency ------------------------------------------------------
-- A stable per-caller request id lets user/AI note creation be retried without
-- producing duplicates. The partial unique index only constrains rows that opt
-- in (client_request_id is not null), so existing rows and callers that do not
-- supply one are unaffected.
alter table public.notebook_notes
  add column if not exists client_request_id text;

alter table public.notebook_notes drop constraint if exists notebook_notes_client_request_id_check;
alter table public.notebook_notes
  add constraint notebook_notes_client_request_id_check
  check (client_request_id is null or client_request_id ~ '^[A-Za-z0-9_-]{8,128}$');

create unique index if not exists notebook_notes_user_client_request_uidx
  on public.notebook_notes (user_id, client_request_id)
  where client_request_id is not null;

-- 5. Change feed + tombstones ------------------------------------------------
-- A monotonic per-user log of note mutations. The device pulls incremental
-- content by change_seq cursor; delete/archive rows are the tombstones.
create table if not exists public.note_change_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  notebook_id uuid not null,
  note_id uuid not null,
  operation text not null,
  revision bigint not null,
  change_seq bigint not null,
  changed_at timestamptz not null default now(),
  constraint note_change_log_operation_check
    check (operation in ('create', 'update', 'archive', 'restore', 'delete'))
);

create unique index if not exists note_change_log_user_seq_uidx
  on public.note_change_log (user_id, change_seq);
create index if not exists note_change_log_user_notebook_idx
  on public.note_change_log (user_id, notebook_id, change_seq);

alter table public.note_change_log enable row level security;
revoke all on table public.note_change_log from anon, authenticated;
grant select on table public.note_change_log to authenticated;
grant all on table public.note_change_log to service_role;

drop policy if exists note_change_log_owner_select on public.note_change_log;
create policy note_change_log_owner_select on public.note_change_log
for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.append_note_change_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_notebook uuid := coalesce(new.notebook_id, old.notebook_id);
  v_note uuid := coalesce(new.id, old.id);
  v_revision bigint := coalesce(new.revision, old.revision, 1);
  v_operation text;
  v_seq bigint;
begin
  if tg_op = 'INSERT' then
    v_operation := 'create';
  elsif tg_op = 'DELETE' then
    v_operation := 'delete';
  elsif old.archived_at is null and new.archived_at is not null then
    v_operation := 'archive';
  elsif old.archived_at is not null and new.archived_at is null then
    v_operation := 'restore';
  else
    v_operation := 'update';
  end if;

  -- Monotonic per-user sequence; the advisory lock serializes concurrent
  -- mutations for the same user so change_seq has no gaps or collisions.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('note-change-log:' || v_user::text, 0::bigint)
  );
  select coalesce(max(change_seq), 0) + 1
    into v_seq
    from public.note_change_log
    where user_id = v_user;

  insert into public.note_change_log (
    user_id, notebook_id, note_id, operation, revision, change_seq
  ) values (
    v_user, v_notebook, v_note, v_operation, v_revision, v_seq
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists append_note_change_log_after_write on public.notebook_notes;
create trigger append_note_change_log_after_write
after insert or update or delete on public.notebook_notes
for each row execute function public.append_note_change_log();
