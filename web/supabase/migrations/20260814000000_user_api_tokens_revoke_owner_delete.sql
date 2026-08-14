-- Security fix (Codex review): revocation of personal access tokens is
-- intentionally soft (revoked_at) so the row keeps serving as an audit record
-- (name/created_at/last_used_at survive). The original grant let any
-- authenticated user physically DELETE their own user_api_tokens rows through
-- the Supabase Data API, bypassing soft revocation and erasing that history.
-- Remove the DELETE grant and the owner DELETE policy; owners keep select plus
-- column-limited revoked_at updates, and token creation stays service-role.
-- Idempotent so environments that already applied 20260801000000 converge.

drop policy if exists user_api_tokens_owner_delete on public.user_api_tokens;
revoke delete on table public.user_api_tokens from authenticated;
