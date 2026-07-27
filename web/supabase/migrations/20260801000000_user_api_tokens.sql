-- Personal access tokens for the public MCP endpoint (/api/mcp).
--
-- External AI clients (Claude Desktop etc.) authenticate with a Bearer token
-- the user generates in the web UI. Mirrors the esp32_devices credential
-- model: the server stores only the SHA-256 digest of the plaintext token
-- (256-bit high-entropy random string -- no slow KDF needed), enforced to a
-- 64-hex format. Revocation is soft (revoked_at) so the row keeps serving as
-- an audit record.

create table if not exists public.user_api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_api_tokens_name_check
    check (char_length(name) between 1 and 60),
  constraint user_api_tokens_hash_format_check
    check (token_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists user_api_tokens_hash_uidx
  on public.user_api_tokens (token_hash);

create index if not exists idx_user_api_tokens_user_created
  on public.user_api_tokens (user_id, created_at desc);

alter table public.user_api_tokens enable row level security;
revoke all on table public.user_api_tokens from anon;
-- Token creation runs through the mcp-tokens route with the service role so
-- plaintext generation and hashing stay server-side; owners may list their
-- own rows and soft-revoke them (column-level grant keeps the hash and
-- ownership immutable from the client).
grant select, delete on table public.user_api_tokens to authenticated;
grant update (revoked_at) on table public.user_api_tokens to authenticated;
grant all on table public.user_api_tokens to service_role;

drop policy if exists user_api_tokens_owner_select on public.user_api_tokens;
create policy user_api_tokens_owner_select
  on public.user_api_tokens
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists user_api_tokens_owner_update on public.user_api_tokens;
create policy user_api_tokens_owner_update
  on public.user_api_tokens
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists user_api_tokens_owner_delete on public.user_api_tokens;
create policy user_api_tokens_owner_delete
  on public.user_api_tokens
for delete to authenticated
using ((select auth.uid()) = user_id);
