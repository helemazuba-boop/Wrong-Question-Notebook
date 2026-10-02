-- Authorization hardening for SECURITY DEFINER joins and RLS write policies.
--
-- Mirrors sections 3 and 4 of upstream's
-- 20260911084312_harden_rpc_and_rls_authorization.sql
-- (mrmagic2020/Wrong-Question-Notebook PR #97, commit 6a2941d). Their
-- sections 1 and 2 are deliberately not copied: this database already revokes
-- EXECUTE from public/anon/authenticated for every SECURITY DEFINER routine
-- (20260719010000, patched by 20260827084903) and runs the four statistics
-- RPCs as SECURITY INVOKER, so re-applying upstream's version would restore
-- the SECURITY DEFINER bodies we removed. Upstream's ALTER of the
-- error_categorisations INSERT policy is also skipped -- that policy was
-- dropped outright in 20260905120000.
--
-- Two classes of defect are fixed here:
--
--   1. SECURITY DEFINER joins. These RPCs already identify the caller, but
--      join through a row the caller can write (review_schedule: RLS only
--      checks user_id) or to rows other users can point at
--      (problems.subject_id). Pinning each join to the owner does not narrow
--      any legitimate result: spaced-repetition sessions are only started for
--      the user's own subjects.
--
--   2. RLS write policies. They constrained a row's user_id but not the
--      foreign keys it points at, so a caller could plant rows that other
--      users' reads then trusted. WITH CHECK applies only to rows being
--      written, so existing data is not re-validated here.
--
-- Per the audit in authz-hardening-2026-09.md: the subject_id-keyed writes
-- (problems, and the metadata reads of get_subjects_with_metadata) are
-- reachable with zero guessing because problem_sets exposes subject_id for
-- every public/limited set, while the problem_id/attempt_id-keyed items
-- additionally require a private UUID that no RLS read path discloses.
--
-- Permissive policies OR together, so tightening one policy is not enough
-- where a second one covers the same command: attempts carries both
-- attempts_owner_all (for all) and "Users can update own attempts" (for
-- update, to public). The latter is dropped here rather than tightened.

-- =====================================================================
-- 1. SECURITY DEFINER joins through caller-writable rows
-- =====================================================================

-- Called from app/api/review-sessions/start-spaced with the user's SSR client.
create or replace function public.get_due_problems_for_subject(
  p_subject_id uuid,
  p_limit integer default 20
)
returns setof public.problems
language sql
stable
security definer
set search_path = ''
as $function$
  select p.*
  from public.review_schedule rs
  join public.problems p
    on p.id = rs.problem_id
   and p.user_id = auth.uid()
  where rs.user_id = auth.uid()
    and p.subject_id = p_subject_id
    and rs.next_review_at <= now()
  order by rs.next_review_at asc
  limit p_limit;
$function$;

revoke all on function public.get_due_problems_for_subject(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_due_problems_for_subject(uuid, integer)
  to authenticated, service_role;

-- No application callers, but reachable through PostgREST by authenticated.
create or replace function public.get_due_problems_count()
returns table(subject_id uuid, due_count bigint)
language sql
stable
security definer
set search_path = ''
as $function$
  select p.subject_id, count(*) as due_count
  from public.review_schedule rs
  join public.problems p
    on p.id = rs.problem_id
   and p.user_id = auth.uid()
  where rs.user_id = auth.uid()
    and rs.next_review_at <= now()
  group by p.subject_id;
$function$;

revoke all on function public.get_due_problems_count()
  from public, anon, authenticated;
grant execute on function public.get_due_problems_count()
  to authenticated, service_role;

-- Called from app/api/subjects and the subjects/todos pages with the user's
-- SSR client. Section 2 stops new foreign problems entering a subject; the
-- owner join here also discounts any that were planted before this migration.
create or replace function public.get_subjects_with_metadata()
returns table(
  id uuid,
  user_id uuid,
  name text,
  color text,
  icon text,
  created_at timestamp with time zone,
  problem_count bigint,
  last_activity timestamp with time zone,
  due_count bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    s.user_id,
    s.name,
    s.color,
    s.icon,
    s.created_at,
    coalesce(count(p.id), 0)::bigint as problem_count,
    max(p.last_reviewed_date) as last_activity,
    coalesce(due.cnt, 0)::bigint as due_count
  from public.subjects s
  left join public.problems p
    on p.subject_id = s.id
   and p.user_id = s.user_id
  left join (
    select p2.subject_id, count(*)::bigint as cnt
    from public.review_schedule rs
    join public.problems p2
      on p2.id = rs.problem_id
     and p2.user_id = auth.uid()
    where rs.user_id = auth.uid()
      and rs.next_review_at <= now()
    group by p2.subject_id
  ) due on due.subject_id = s.id
  where s.user_id = auth.uid()
  group by s.id, s.user_id, s.name, s.color, s.icon, s.created_at, due.cnt
  order by s.created_at asc;
$function$;

revoke all on function public.get_subjects_with_metadata()
  from public, anon, authenticated;
grant execute on function public.get_subjects_with_metadata()
  to authenticated, service_role;

-- =====================================================================
-- 2. RLS write policies -- require ownership of referenced rows
--
-- service_role bypasses RLS, so the app's server-side writers are unaffected
-- throughout. The two altered policies that were still declared TO public are
-- narrowed to authenticated: both compare against auth.uid(), so anon could
-- never pass, and the narrower role removes the policy from anon's surface.
-- (The third TO public policy here, "Users can update own attempts", is dropped
-- instead of narrowed -- see below.)
-- =====================================================================

-- problem_status_history: the app never inserts directly -- rows come only
-- from the SECURITY DEFINER track_problem_status_change() trigger, which
-- bypasses RLS. Without an ownership check, a planted row on a victim's
-- problem is also hijacked by that trigger's ON CONFLICT (problem_id,
-- changed_date) upsert: the victim's real status change for that day lands in
-- the attacker-owned row and is missing from the victim's own history.
alter policy "Users can insert own history" on public.problem_status_history
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.problems p
      where p.id = problem_status_history.problem_id
        and p.user_id = (select auth.uid())
    )
  );

-- error_categorisations UPDATE: USING (and so the implicit check) only
-- constrained user_id. All three NOT NULL foreign keys are pinned: repointing
-- attempt_id claims another user's attempt (and the UNIQUE (attempt_id)
-- constraint then makes the real AI categorisation skip it), while
-- problem_id/subject_id reach the same joins from the other side. The app's
-- override route only changes category fields on a row it selected by
-- id + user_id, so every legitimate row is written for its own user.
alter policy "Users can update own categorisations" on public.error_categorisations
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.attempts a
      where a.id = error_categorisations.attempt_id
        and a.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.problems p
      where p.id = error_categorisations.problem_id
        and p.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.subjects s
      where s.id = error_categorisations.subject_id
        and s.user_id = (select auth.uid())
    )
  );

-- problems: subject_id was an unchecked FK, so a user could insert or move a
-- problem into another user's subject (and, through that, poison the counts
-- get_subjects_with_metadata derives). Every app writer targets the user's own
-- subjects -- the copy routes and the ingestion workspace check it explicitly,
-- and the MCP path resolves it through resolveSubject().
alter policy problems_insert_policy on public.problems
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.subjects s
      where s.id = problems.subject_id
        and s.user_id = (select auth.uid())
    )
  );

alter policy problems_update_policy on public.problems
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.subjects s
      where s.id = problems.subject_id
        and s.user_id = (select auth.uid())
    )
  );

-- attempts: problem_id was an unchecked FK too. The subquery below is
-- evaluated as the caller, so the SELECT policies on problems still apply:
-- the check passes exactly when the caller can see the referenced problem.
-- That keeps the legitimate cross-account write -- practising a shared
-- problem set records an attempt on its owner's problem
-- (app/api/problems/[id]/attempt fetches the problem through the service
-- client so non-owner viewers can auto-mark, then inserts with the user's
-- own session) -- while rejecting attempts on problems the caller cannot see.
alter policy attempts_owner_all on public.attempts
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.problems p
      where p.id = attempts.problem_id
    )
  );

-- "Users can update own attempts" (for update, to public, user_id only) is a
-- second permissive policy on UPDATE and would OR past the check above.
-- attempts_owner_all already grants authenticated owners UPDATE, and anon
-- cannot pass auth.uid() checks, so dropping it narrows nothing legitimate.
drop policy "Users can update own attempts" on public.attempts;

-- review_schedule: reading the row is harmless on its own, but a planted row
-- still pollutes the planter's own due counts (app/api/esp32/v3/sync) and
-- surfaces as an empty entry in the MCP due tools. The only user-session
-- writers point at a problem the caller just created
-- (lib/problem-creation-service.ts, lib/problem-ingestion-workspace-service.ts);
-- the FSRS projector, the device routes and app/api/problems all write
-- through service_role, which bypasses RLS.
alter policy review_owner_all on public.review_schedule
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.problems p
      where p.id = review_schedule.problem_id
        and p.user_id = (select auth.uid())
    )
  );

-- =====================================================================
-- 3. Self-check -- fail the push if the invariants above were not applied
--
-- Same shape as 20260719010000: a SECURITY DEFINER function without a fixed
-- search_path, or one still executable by PUBLIC, aborts `supabase db push`
-- instead of surfacing later as a security regression.
-- =====================================================================

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
  ) then
    raise exception 'SECURITY DEFINER function without fixed search_path';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    where n.nspname = 'public'
      and p.prosecdef
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'SECURITY DEFINER function executable by PUBLIC';
  end if;
end
$$;

do $$
declare
  v_missing text;
begin
  select string_agg(format('%s.%s', t.tablename, t.policyname), ', ')
  into v_missing
  from pg_policies t
  where t.schemaname = 'public'
    and (t.tablename, t.policyname) in (
      ('problem_status_history', 'Users can insert own history'),
      ('error_categorisations', 'Users can update own categorisations'),
      ('problems', 'problems_insert_policy'),
      ('problems', 'problems_update_policy'),
      ('attempts', 'attempts_owner_all'),
      ('review_schedule', 'review_owner_all')
    )
    and (
      t.with_check is null
      or t.with_check not ilike '%exists%'
    );

  if v_missing is not null then
    raise exception 'policy without ownership check: %', v_missing;
  end if;
end
$$;
