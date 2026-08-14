-- Monotonic per-domain revision source for device convergence. Entity-local
-- max(revision) is not sufficient: deleting the last row makes it go back to
-- zero and cannot tell an offline device to remove stale content.

create sequence if not exists public.device_content_revision_seq;

create table if not exists public.device_content_revisions (
  scope_key text not null,
  domain text not null,
  revision bigint not null default nextval('public.device_content_revision_seq'),
  updated_at timestamptz not null default now(),
  primary key (scope_key, domain),
  constraint device_content_revisions_domain_check
    check (domain in ('todos', 'word_packs', 'note_packs', 'problem_packs')),
  constraint device_content_revisions_revision_check check (revision >= 1)
);

alter table public.device_content_revisions enable row level security;
revoke all on table public.device_content_revisions from anon, authenticated;

create or replace function public.bump_device_content_revision(
  p_scope_key text,
  p_domain text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_scope_key is null or p_scope_key = '' then
    return;
  end if;
  insert into public.device_content_revisions(scope_key, domain, revision, updated_at)
  values (
    p_scope_key,
    p_domain,
    nextval('public.device_content_revision_seq'),
    now()
  )
  on conflict (scope_key, domain) do update
  set revision = nextval('public.device_content_revision_seq'),
      updated_at = now();
end;
$$;

revoke all on function public.bump_device_content_revision(text, text)
  from public, anon, authenticated;

create or replace function public.bump_device_content_from_user_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  perform public.bump_device_content_revision(v_user_id::text, tg_argv[0]);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.bump_device_word_entry_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deck_id uuid := case when tg_op = 'DELETE' then old.deck_id else new.deck_id end;
  v_scope text;
begin
  select case when d.is_system then '*' else d.user_id::text end
    into v_scope
    from public.word_decks d
   where d.id = v_deck_id;
  perform public.bump_device_content_revision(v_scope, 'word_packs');
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.bump_device_word_deck_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := case
    when (case when tg_op = 'DELETE' then old.is_system else new.is_system end)
      then '*'
    else (case when tg_op = 'DELETE' then old.user_id else new.user_id end)::text
  end;
begin
  perform public.bump_device_content_revision(v_scope, 'word_packs');
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists device_content_notebooks on public.notebooks;
create trigger device_content_notebooks
after insert or update or delete on public.notebooks
for each row execute function public.bump_device_content_from_user_row('note_packs');

drop trigger if exists device_content_notebook_notes on public.notebook_notes;
create trigger device_content_notebook_notes
after insert or update or delete on public.notebook_notes
for each row execute function public.bump_device_content_from_user_row('note_packs');

drop trigger if exists device_content_todos on public.todos;
create trigger device_content_todos
after insert or update or delete on public.todos
for each row execute function public.bump_device_content_from_user_row('todos');

drop trigger if exists device_content_problems on public.problems;
create trigger device_content_problems
after insert or update or delete on public.problems
for each row execute function public.bump_device_content_from_user_row('problem_packs');

drop trigger if exists device_content_problem_sets on public.problem_sets;
create trigger device_content_problem_sets
after insert or update or delete on public.problem_sets
for each row execute function public.bump_device_content_from_user_row('problem_packs');

drop trigger if exists device_content_problem_set_problems on public.problem_set_problems;
create trigger device_content_problem_set_problems
after insert or update or delete on public.problem_set_problems
for each row execute function public.bump_device_content_from_user_row('problem_packs');

drop trigger if exists device_content_word_decks on public.word_decks;
create trigger device_content_word_decks
after insert or update or delete on public.word_decks
for each row execute function public.bump_device_word_deck_content();

drop trigger if exists device_content_word_entries on public.word_entries;
create trigger device_content_word_entries
after insert or update or delete on public.word_entries
for each row execute function public.bump_device_word_entry_content();

-- Seed one non-zero target per existing user/domain. Future mutations always
-- advance the global sequence, including deletion of the last entity.
insert into public.device_content_revisions(scope_key, domain)
select u.user_id::text, d.domain
from (
  select user_id from public.notebooks
  union select user_id from public.notebook_notes
  union select user_id from public.todos
  union select user_id from public.problems
  union select user_id from public.problem_sets
  union select user_id from public.word_decks where user_id is not null
) u
cross join (values ('todos'), ('word_packs'), ('note_packs'), ('problem_packs')) d(domain)
on conflict (scope_key, domain) do nothing;

insert into public.device_content_revisions(scope_key, domain)
values ('*', 'word_packs')
on conflict (scope_key, domain) do nothing;

create or replace function public.get_device_content_revisions(p_user_id uuid)
returns table(domain text, revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.device_content_revisions(scope_key, domain)
  select p_user_id::text, candidate.domain
  from (values ('todos'), ('word_packs'), ('note_packs'), ('problem_packs'))
       candidate(domain)
  where not exists (
    select 1
    from public.device_content_revisions existing
    where existing.scope_key = p_user_id::text
      and existing.domain = candidate.domain
  );

  return query
  select r.domain, max(r.revision)::bigint
  from public.device_content_revisions r
  where r.scope_key = p_user_id::text
     or (r.scope_key = '*' and r.domain = 'word_packs')
  group by r.domain;
end;
$$;

revoke all on function public.get_device_content_revisions(uuid)
  from public, anon, authenticated;
grant execute on function public.get_device_content_revisions(uuid)
  to service_role;

create table if not exists public.device_pack_artifacts (
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  logical_id uuid not null,
  revision bigint not null,
  sha256 text not null,
  storage_path text not null,
  byte_size bigint not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, domain, logical_id, sha256),
  constraint device_pack_artifacts_domain_check
    check (domain in ('note_packs', 'problem_packs')),
  constraint device_pack_artifacts_sha_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint device_pack_artifacts_size_check check (byte_size >= 0)
);

create table if not exists public.device_image_artifacts (
  user_id uuid not null references auth.users(id) on delete cascade,
  image_id text not null,
  pixel_format text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, image_id),
  constraint device_image_artifacts_id_check check (image_id ~ '^[0-9a-f]{64}$'),
  constraint device_image_artifacts_format_check
    check (pixel_format in ('bw1', 'gray4'))
);

alter table public.device_pack_artifacts enable row level security;
alter table public.device_image_artifacts enable row level security;
revoke all on table public.device_pack_artifacts from anon, authenticated;
revoke all on table public.device_image_artifacts from anon, authenticated;

create index if not exists idx_device_pack_artifacts_sha
  on public.device_pack_artifacts(user_id, sha256);
create index if not exists idx_device_image_artifacts_seen
  on public.device_image_artifacts(user_id, last_seen_at desc);

-- Preserve current image identities before any attachment is reordered or
-- detached. Future pack materialization refreshes last_seen_at.
insert into public.device_image_artifacts(
  user_id, image_id, pixel_format, storage_path
)
select n.user_id, asset->>'image_id', 'bw1', asset->>'display_path'
from public.notebook_notes n
cross join lateral jsonb_array_elements(coalesce(n.assets, '[]'::jsonb)) asset
where asset->>'image_id' ~ '^[0-9a-f]{64}$'
  and coalesce(asset->>'display_path', '') <> ''
on conflict (user_id, image_id) do update
set storage_path = excluded.storage_path, last_seen_at = now();

insert into public.device_image_artifacts(
  user_id, image_id, pixel_format, storage_path
)
select n.user_id, asset->>'gray4_image_id', 'gray4', asset->>'gray4_display_path'
from public.notebook_notes n
cross join lateral jsonb_array_elements(coalesce(n.assets, '[]'::jsonb)) asset
where asset->>'gray4_image_id' ~ '^[0-9a-f]{64}$'
  and coalesce(asset->>'gray4_display_path', '') <> ''
on conflict (user_id, image_id) do update
set storage_path = excluded.storage_path, last_seen_at = now();

insert into public.device_image_artifacts(
  user_id, image_id, pixel_format, storage_path
)
select p.user_id, asset->>'image_id', 'bw1', asset->>'display_path'
from public.problems p
cross join lateral jsonb_array_elements(
  coalesce(p.assets, '[]'::jsonb) || coalesce(p.solution_assets, '[]'::jsonb)
) asset
where asset->>'image_id' ~ '^[0-9a-f]{64}$'
  and coalesce(asset->>'display_path', '') <> ''
on conflict (user_id, image_id) do update
set storage_path = excluded.storage_path, last_seen_at = now();

insert into public.device_image_artifacts(
  user_id, image_id, pixel_format, storage_path
)
select p.user_id, asset->>'gray4_image_id', 'gray4', asset->>'gray4_display_path'
from public.problems p
cross join lateral jsonb_array_elements(
  coalesce(p.assets, '[]'::jsonb) || coalesce(p.solution_assets, '[]'::jsonb)
) asset
where asset->>'gray4_image_id' ~ '^[0-9a-f]{64}$'
  and coalesce(asset->>'gray4_display_path', '') <> ''
on conflict (user_id, image_id) do update
set storage_path = excluded.storage_path, last_seen_at = now();
