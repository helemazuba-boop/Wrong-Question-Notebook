-- Remove three RLS policies that were named "Service role can ..." but were
-- authored with `to public` and always-true checks. service_role bypasses RLS
-- entirely and never needs a policy, while Supabase grants full table DML to
-- anon/authenticated by default - so these policies let any anonymous or
-- authenticated client insert into error_categorisations and insert/delete
-- insight_digests through the REST API.

drop policy if exists "Service role can insert categorisations"
  on public.error_categorisations;

drop policy if exists "Service role can delete digests"
  on public.insight_digests;

drop policy if exists "Service role can manage digests"
  on public.insight_digests;
