-- Security baseline required before restoring the platform database onto the
-- self-hosted data.helema.cn stack. Historical migrations remain immutable.

-- Application roles must not be able to shadow relations/functions resolved
-- by SECURITY DEFINER routines.
revoke create on schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- PostgreSQL grants function execution to PUBLIC by default. Start from a
-- deny-by-default baseline for every SECURITY DEFINER routine, then grant the
-- small set of browser-facing RPCs explicitly below.
do $$
declare
  fn record;
begin
  for fn in
    select
      p.oid::regprocedure as signature,
      coalesce(p.proconfig, array[]::text[]) as settings
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      fn.signature
    );
    execute format(
      'grant execute on function %s to service_role',
      fn.signature
    );

    if not exists (
      select 1
      from unnest(fn.settings) setting
      where setting like 'search_path=%'
    ) then
      execute format(
        'alter function %s set search_path to pg_catalog, public, auth, storage, extensions',
        fn.signature
      );
    end if;
  end loop;
end
$$;

-- These user-facing statistics functions only read RLS-protected tables.
-- SECURITY INVOKER makes the caller's JWT/RLS context authoritative even if a
-- malicious caller supplies another user's UUID.
alter function public.get_recent_study_activity(uuid) security invoker;
alter function public.get_session_statistics(uuid) security invoker;
alter function public.get_subject_breakdown(uuid) security invoker;
alter function public.get_user_statistics(uuid) security invoker;

grant execute on function public.get_recent_study_activity(uuid) to authenticated;
grant execute on function public.get_session_statistics(uuid) to authenticated;
grant execute on function public.get_subject_breakdown(uuid) to authenticated;
grant execute on function public.get_user_statistics(uuid) to authenticated;

-- Browser-facing SECURITY DEFINER routines are safe because they derive the
-- user from auth.uid() or expose aggregate public discovery data only.
grant execute on function public.can_view_problem(uuid) to authenticated;
grant execute on function public.get_due_problems_count() to authenticated;
grant execute on function public.get_due_problems_for_subject(uuid, integer) to authenticated;
grant execute on function public.get_subjects_with_metadata() to authenticated;
grant execute on function public.log_user_activity(character varying, character varying, uuid, jsonb)
  to authenticated;
grant execute on function public.user_owns_problem_with_asset(text) to authenticated;
grant execute on function public.get_discovery_subject_counts() to anon, authenticated;

-- The historical function declared an empty search_path while using
-- unqualified relations. Keep it service-only but make it operational.
alter function public.get_problem_set_progress(uuid, uuid)
  set search_path to pg_catalog, public;

-- Fail the migration if a SECURITY DEFINER function still inherits a mutable
-- session search_path or remains executable by the implicit PUBLIC role.
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
