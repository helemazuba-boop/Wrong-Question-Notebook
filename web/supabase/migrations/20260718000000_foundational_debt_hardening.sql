-- Foundational data-integrity and security hardening.
--
-- This migration is intentionally additive. It brings existing installations
-- forward without rewriting migration history and keeps `supabase db push`
-- safe for databases that already contain these objects.

-- pgcrypto is needed by the AI audit hash below. 20260717000000_esp32_token_hash
-- already creates it, but `IF NOT EXISTS` keeps this migration self-sufficient
-- when run standalone (e.g. orchestrator ordering that skips 017).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Storage buckets referenced by the application must exist after a clean reset.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'avatars',
    'avatars',
    true,
    2097152,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  ),
  (
    'problem-uploads',
    'problem-uploads',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
  )
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Device tokens are required credentials. Once the hash migration has run,
-- reject malformed/null hashes rather than allowing unauthenticatable rows.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'esp32_devices'
      and column_name = 'access_token_hash'
  ) then
    if exists (
      select 1
      from public.esp32_devices
      where access_token_hash is null
        or access_token_hash !~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'esp32_devices contains an invalid access_token_hash';
    end if;

    alter table public.esp32_devices
      alter column access_token_hash set not null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'esp32_devices_token_hash_format_check'
        and conrelid = 'public.esp32_devices'::regclass
    ) then
      alter table public.esp32_devices
        add constraint esp32_devices_token_hash_format_check
        check (access_token_hash ~ '^[0-9a-f]{64}$');
    end if;
  end if;
end
$$;

-- Optimistic revisions are the common conflict-detection primitive for cloud
-- entities. The trigger only increments when a caller did not explicitly
-- advance the revision, which also supports compare-and-swap API updates.
alter table public.notebooks add column if not exists revision bigint not null default 1;
alter table public.notebook_notes add column if not exists revision bigint not null default 1;
alter table public.todos add column if not exists revision bigint not null default 1;
alter table public.problems add column if not exists revision bigint not null default 1;

alter table public.notebooks drop constraint if exists notebooks_revision_check;
alter table public.notebooks add constraint notebooks_revision_check check (revision >= 1);
alter table public.notebook_notes drop constraint if exists notebook_notes_revision_check;
alter table public.notebook_notes add constraint notebook_notes_revision_check check (revision >= 1);
alter table public.todos drop constraint if exists todos_revision_check;
alter table public.todos add constraint todos_revision_check check (revision >= 1);
alter table public.problems drop constraint if exists problems_revision_check;
alter table public.problems add constraint problems_revision_check check (revision >= 1);

create or replace function public.bump_entity_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.revision <= old.revision then
    new.revision = old.revision + 1;
  end if;
  return new;
end;
$$;

create or replace function public.install_revision_trigger(p_table regclass)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trigger_name text := 'bump_' || replace(p_table::text, '.', '_') || '_revision';
begin
  execute format('drop trigger if exists %I on %s', v_trigger_name, p_table);
  execute format(
    'create trigger %I before update on %s for each row execute function public.bump_entity_revision()',
    v_trigger_name,
    p_table
  );
end;
$$;

select public.install_revision_trigger('public.notebooks'::regclass);
select public.install_revision_trigger('public.notebook_notes'::regclass);
select public.install_revision_trigger('public.todos'::regclass);
select public.install_revision_trigger('public.problems'::regclass);
drop function public.install_revision_trigger(regclass);

-- Activity history is append-only application data. Clients may call the
-- SECURITY DEFINER RPC, but may not mutate/truncate the table directly.
revoke all on table public.user_activity_log from anon, authenticated;
grant select on table public.user_activity_log to authenticated;
revoke all on function public.log_user_activity(character varying, character varying, uuid, jsonb)
  from public, anon;
grant execute on function public.log_user_activity(character varying, character varying, uuid, jsonb)
  to authenticated;

alter function public.log_user_activity(character varying, character varying, uuid, jsonb)
  set search_path = '';

-- Immutable provenance for AI-created notebook notes. Keeping this separate
-- from the mutable note row preserves the creation record after edits/deletes.
create table if not exists public.notebook_ai_audit_log (
  id bigint generated always as identity primary key,
  note_id uuid not null,
  notebook_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text,
  title text not null,
  content_sha256 text not null,
  linked_problem_id uuid,
  created_at timestamptz not null default now(),
  constraint notebook_ai_audit_content_hash_check
    check (content_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists notebook_ai_audit_log_user_created_idx
  on public.notebook_ai_audit_log (user_id, created_at desc);
create index if not exists notebook_ai_audit_log_note_idx
  on public.notebook_ai_audit_log (note_id);

alter table public.notebook_ai_audit_log enable row level security;
revoke all on table public.notebook_ai_audit_log from anon, authenticated;
grant select on table public.notebook_ai_audit_log to authenticated;

drop policy if exists notebook_ai_audit_owner_select on public.notebook_ai_audit_log;
create policy notebook_ai_audit_owner_select on public.notebook_ai_audit_log
for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.audit_ai_notebook_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source = 'ai' then
    insert into public.notebook_ai_audit_log (
      note_id,
      notebook_id,
      user_id,
      conversation_id,
      title,
      content_sha256,
      linked_problem_id
    ) values (
      new.id,
      new.notebook_id,
      new.user_id,
      nullif(new.metadata ->> 'source_conversation_id', ''),
      new.title,
      encode(extensions.digest(convert_to(new.content, 'UTF8'), 'sha256'), 'hex'),
      new.linked_problem_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_ai_notebook_note_after_insert on public.notebook_notes;
create trigger audit_ai_notebook_note_after_insert
after insert on public.notebook_notes
for each row execute function public.audit_ai_notebook_note();
