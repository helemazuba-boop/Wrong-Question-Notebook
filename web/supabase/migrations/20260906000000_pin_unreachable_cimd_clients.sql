-- Pin well-known MCP clients whose Client ID Metadata Documents are served by
-- hosts this deployment cannot reach.
--
-- WHY THIS EXISTS
--
-- MCP prefers CIMD over Dynamic Client Registration: the client_id is an
-- HTTPS URL and lib/oauth/cimd.ts fetches that document to learn the client's
-- redirect URIs. That fetch needs outbound internet access from the app
-- server. Where egress is restricted or the host is filtered, every CIMD
-- client fails with "The application could not be identified" even though the
-- document itself is perfectly valid -- the failure is in reaching it, not in
-- validating it.
--
-- lib/oauth/clients.ts now consults oauth_clients BEFORE fetching, so a row
-- here short-circuits the fetch entirely and pins that client's metadata.
-- Unknown clients still go through CIMD.
--
-- HOW TO ADD A CLIENT
--
-- 1. Fetch the document yourself and read it:
--      curl -s https://<client-host>/oauth/client.json
-- 2. Copy client_id and client_name VERBATIM, and every redirect_uri you are
--    willing to deliver an authorization code to.
-- 3. INSERT them below. Do not widen redirect_uris beyond what the document
--    declares: redirect_uris is the only thing standing between a consent
--    click and an authorization code landing on an attacker's endpoint.
--
-- MAINTENANCE
--
-- This is a fallback, not the happy path. Once outbound HTTPS works from the
-- app server, delete these rows and let CIMD serve them -- a pinned row goes
-- stale if the client rotates its redirect URIs, whereas the live document
-- tracks it automatically. Re-verify against the live document periodically
-- while the pin remains.

insert into public.oauth_clients (
  client_id,
  client_name,
  client_secret_hash,
  redirect_uris,
  grant_types,
  response_types,
  is_dynamic
) values (
  'https://chatgpt.com/oauth/client.json',
  'ChatGPT',
  null,
  array['https://chatgpt.com/connector_platform_oauth_redirect'],
  array['authorization_code', 'refresh_token'],
  array['code'],
  true
)
on conflict (client_id) do update
set redirect_uris = excluded.redirect_uris,
    client_name = excluded.client_name;
