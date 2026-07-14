-- esp32_ai_conversations: persistent STD/PRO voice-AI conversation history.
--
-- Mirrors the notebook pattern (user-owned rows, RLS) but is a dedicated
-- table so the core notebooks schema stays untouched. One row per
-- conversation; turns are appended as a jsonb array of
--   { role: 'user' | 'assistant', content: text, created_at: timestamptz }.
--
-- Surfacing these conversations as a "blank notebook" type in the notebook
-- shelf is deferred to the UI refactor; for now this table is the cloud-side
-- source of truth that the v2 streaming / v1 chat paths load multi-turn
-- context from. The ESP32 device holds context only for the active visit and
-- clears it on leave, so each visit starts a fresh conversation_id.
--
-- Apply manually (the project does not track migrations in-repo):
--   supabase db execute / dashboard SQL editor / psql.

create table if not exists public.esp32_ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text,
  conversation_id text not null,
  tier text not null default 'std',
  title text,
  turns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_turn_at timestamptz not null default now(),
  unique (user_id, conversation_id)
);

create index if not exists esp32_ai_conversations_user_id_idx
  on public.esp32_ai_conversations (user_id);
create index if not exists esp32_ai_conversations_conversation_id_idx
  on public.esp32_ai_conversations (conversation_id);
create index if not exists esp32_ai_conversations_last_turn_at_idx
  on public.esp32_ai_conversations (last_turn_at desc);

alter table public.esp32_ai_conversations enable row level security;

drop policy if exists "users select own ai conversations" on public.esp32_ai_conversations;
create policy "users select own ai conversations"
  on public.esp32_ai_conversations for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own ai conversations" on public.esp32_ai_conversations;
create policy "users insert own ai conversations"
  on public.esp32_ai_conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own ai conversations" on public.esp32_ai_conversations;
create policy "users update own ai conversations"
  on public.esp32_ai_conversations for update
  using (auth.uid() = user_id);

drop policy if exists "users delete own ai conversations" on public.esp32_ai_conversations;
create policy "users delete own ai conversations"
  on public.esp32_ai_conversations for delete
  using (auth.uid() = user_id);

-- updated_at / last_turn_at auto-maintenance.
create or replace function public.touch_esp32_ai_conversation_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  new.last_turn_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_esp32_ai_conversations_updated_at on public.esp32_ai_conversations;
create trigger trg_esp32_ai_conversations_updated_at
  before update on public.esp32_ai_conversations
  for each row execute function public.touch_esp32_ai_conversation_updated_at();
