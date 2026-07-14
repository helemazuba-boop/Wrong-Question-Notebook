create table if not exists public.word_packs (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.word_decks(id) on delete cascade,
  revision bigint not null,
  schema_version integer not null default 1,
  format text not null default 'jsonl',
  compression text not null default 'none',
  storage_path text not null,
  sha256 text not null,
  byte_size bigint not null,
  entry_count integer not null,
  status text not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint word_packs_revision_check check (revision >= 1),
  constraint word_packs_schema_version_check check (schema_version = 1),
  constraint word_packs_format_check check (format in ('jsonl')),
  constraint word_packs_compression_check check (compression in ('none')),
  constraint word_packs_sha256_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint word_packs_byte_size_check check (byte_size >= 0),
  constraint word_packs_entry_count_check check (entry_count >= 0),
  constraint word_packs_status_check check (status in ('ready', 'stale', 'failed'))
);

alter table public.word_packs enable row level security;

grant select on table public.word_packs to authenticated;
grant all on table public.word_packs to service_role;

create unique index if not exists idx_word_packs_deck_revision_variant
  on public.word_packs(deck_id, revision, schema_version, format, compression);

create index if not exists idx_word_packs_deck_updated
  on public.word_packs(deck_id, updated_at desc);

drop trigger if exists set_word_packs_updated_at on public.word_packs;
create trigger set_word_packs_updated_at
before update on public.word_packs
for each row execute function public.word_touch_updated_at();

drop policy if exists word_packs_visible_select on public.word_packs;
create policy word_packs_visible_select on public.word_packs
for select to authenticated
using (
  exists (
    select 1
    from public.word_decks d
    where d.id = word_packs.deck_id
      and d.is_active = true
      and d.archived_at is null
      and (d.user_id = auth.uid() or d.is_system = true)
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'word-packs',
  'word-packs',
  false,
  10485760,
  array['application/x-ndjson', 'application/jsonl', 'application/octet-stream']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
