-- Authorization server for the public MCP endpoint (/api/mcp).
--
-- Implements OAuth 2.1 authorization-code flow with PKCE (RFC 7636) so MCP
-- clients (Claude Desktop, Cursor, ...) can obtain a Bearer token without the
-- user hand-copying a PAT into a config file. Three moving parts:
--
--   oauth_clients            registered / dynamically registered clients
--   oauth_authorization_codes  single-use codes binding a PKCE challenge
--   oauth_tokens             access + refresh token pairs
--
-- Credential storage mirrors user_api_tokens.sql and esp32_devices: only the
-- SHA-256 hex digest of the plaintext is stored, because every secret here is
-- a 256-bit high-entropy random string (no slow KDF needed). Revocation is
-- soft so rows keep serving as an audit record -- note that this is what makes
-- refresh-token reuse detectable after rotation.

create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  client_name text not null,
  -- Public clients (desktop apps cannot hold a secret) leave this null; the
  -- flow relies on PKCE instead of client authentication.
  client_secret_hash text,
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  is_dynamic boolean not null default true,
  created_at timestamptz not null default now(),
  constraint oauth_clients_id_key
    unique (client_id),
  constraint oauth_clients_name_check
    check (char_length(client_name) between 1 and 100),
  constraint oauth_clients_secret_hash_format_check
    check (client_secret_hash is null or client_secret_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_clients_redirect_uris_check
    check (cardinality(redirect_uris) between 1 and 20),
  constraint oauth_clients_grant_types_check
    check (grant_types <@ array['authorization_code', 'refresh_token']),
  constraint oauth_clients_response_types_check
    check (response_types <@ array['code'])
);

create table if not exists public.oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  client_id text not null
    references public.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  scope text not null default 'mcp:all',
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  expires_at timestamptz not null,
  -- Set by the token endpoint when the code is redeemed. Consumption must be
  -- a conditional UPDATE (... WHERE used_at IS NULL) so two concurrent
  -- redemptions cannot both win.
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_authorization_codes_hash_key
    unique (code_hash),
  constraint oauth_authorization_codes_hash_format_check
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_authorization_codes_challenge_method_check
    check (code_challenge_method = 'S256'),
  constraint oauth_authorization_codes_challenge_format_check
    check (code_challenge ~ '^[A-Za-z0-9_-]{43}$')
);

create index if not exists idx_oauth_authorization_codes_lookup
  on public.oauth_authorization_codes (code_hash, used_at, expires_at);

-- Lets a periodic sweep drop codes that expired unredeemed.
create index if not exists idx_oauth_authorization_codes_expires
  on public.oauth_authorization_codes (expires_at);

create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null
    references public.oauth_clients(client_id) on delete cascade,
  access_token_hash text not null,
  refresh_token_hash text,
  scope text not null default 'mcp:all',
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_tokens_access_hash_key
    unique (access_token_hash),
  constraint oauth_tokens_refresh_hash_key
    unique (refresh_token_hash),
  constraint oauth_tokens_access_hash_format_check
    check (access_token_hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_tokens_refresh_hash_format_check
    check (refresh_token_hash is null or refresh_token_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists idx_oauth_tokens_access
  on public.oauth_tokens (access_token_hash, revoked_at, access_token_expires_at);

create index if not exists idx_oauth_tokens_refresh
  on public.oauth_tokens (refresh_token_hash, revoked_at);

create index if not exists idx_oauth_tokens_user
  on public.oauth_tokens (user_id, created_at desc);

-- Revoking every token of a (user, client) pair is the response to refresh
-- token reuse, so that pair needs to be cheap to scan.
create index if not exists idx_oauth_tokens_user_client
  on public.oauth_tokens (user_id, client_id);

alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_tokens enable row level security;

revoke all on table public.oauth_clients from anon;
revoke all on table public.oauth_authorization_codes from anon;
revoke all on table public.oauth_tokens from anon;

-- Registration, code issuance and token exchange all run through the service
-- role: the plaintext secrets must never reach the client, and the lookup
-- tables are not meant to be readable by their holders. Owners get to list
-- and revoke their own tokens from the settings UI.
grant select on table public.oauth_tokens to authenticated;
grant update (revoked_at) on table public.oauth_tokens to authenticated;
grant all on table public.oauth_clients to service_role;
grant all on table public.oauth_authorization_codes to service_role;
grant all on table public.oauth_tokens to service_role;

drop policy if exists oauth_tokens_owner_select on public.oauth_tokens;
create policy oauth_tokens_owner_select
  on public.oauth_tokens
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists oauth_tokens_owner_revoke on public.oauth_tokens;
create policy oauth_tokens_owner_revoke
  on public.oauth_tokens
for update to authenticated
using ((select auth.uid()) = user_id and revoked_at is null)
with check (
  (select auth.uid()) = user_id
  -- Revocation is one-way: without this an owner could set revoked_at back to
  -- null and resurrect a token they had already killed.
  and revoked_at is not null
);
