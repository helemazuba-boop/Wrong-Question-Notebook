-- RFC 8707 resource indicators for the OAuth authorization server.
--
-- Follow-up to 20260905000000_oauth_server.sql, which is already applied on
-- the self-hosted database.
--
-- An access token is only valid for the resource it was requested for. MCP
-- clients send `resource=<canonical MCP URI>` on the authorize and token
-- requests, and the server records it here so /api/mcp can reject a token
-- that was minted for something else (audience check). Without the column a
-- stolen token from any other audience of this issuer would be accepted.
--
-- Left nullable because existing rows predate the column; the resource is
-- always written by the authorize/token endpoints and the MCP endpoint treats
-- a NULL as a mismatch (fails closed), so a missing value can only lock a
-- token out, never widen it.

alter table public.oauth_authorization_codes
  add column if not exists resource text;

alter table public.oauth_tokens
  add column if not exists resource text;

comment on column public.oauth_authorization_codes.resource is
  'Canonical URI of the resource this code was requested for (RFC 8707).';

comment on column public.oauth_tokens.resource is
  'Audience of the access token (RFC 8707); must match the MCP endpoint URI.';
