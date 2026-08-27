-- Follow-up SECURITY DEFINER hardening.
--
-- Later CREATE OR REPLACE / DROP+CREATE migrations reintroduced functions
-- without a fixed search_path and/or restored PostgreSQL's default PUBLIC
-- EXECUTE privilege.

-- ---------------------------------------------------------------------------
-- Functions recreated after the original self-hosted hardening migration.
-- Their bodies use unqualified public objects, so keep a narrow deterministic
-- search_path rather than relying on the caller/session search_path.
-- ---------------------------------------------------------------------------

alter function public.compute_problem_set_count(uuid)
  set search_path = pg_catalog, public;

alter function public.refresh_ranking_scores()
  set search_path = pg_catalog, public;

alter function public.get_uncategorised_attempts(uuid, integer)
  set search_path = pg_catalog, public;

-- get_uncategorised_attempts is a server-side maintenance RPC invoked through
-- createServiceClient(); it must never be callable by browser roles.
revoke execute on function public.get_uncategorised_attempts(uuid, integer)
  from public, anon, authenticated;

grant execute on function public.get_uncategorised_attempts(uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Trigger-only SECURITY DEFINER helpers.
-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default; triggers do
-- not require clients to hold EXECUTE on their trigger functions.
-- ---------------------------------------------------------------------------

revoke execute on function public.append_note_change_log()
  from public, anon, authenticated;

revoke execute on function public.assign_notebook_note_sort_index()
  from public, anon, authenticated;

revoke execute on function public.bump_device_content_from_user_row()
  from public, anon, authenticated;

revoke execute on function public.bump_device_word_deck_content()
  from public, anon, authenticated;

revoke execute on function public.bump_device_word_entry_content()
  from public, anon, authenticated;

revoke execute on function public.log_word_change_v1()
  from public, anon, authenticated;
