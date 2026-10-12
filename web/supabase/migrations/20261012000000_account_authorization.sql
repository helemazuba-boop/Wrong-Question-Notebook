-- Profile ownership does not authorize changing the account's privilege state.
revoke insert, update, delete, truncate, references, trigger
  on public.user_profiles from anon, authenticated;
grant update (username, first_name, last_name, date_of_birth, gender, region,
  timezone, avatar_url, bio, onboarding_completed_at)
  on public.user_profiles to authenticated;

create or replace function public.guard_profile_privileges()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.user_role is distinct from 'user' or new.is_active is distinct from true then
        raise exception 'protected account fields' using errcode = '42501';
      end if;
    elsif new.id is distinct from old.id
       or new.user_role is distinct from old.user_role
       or new.is_active is distinct from old.is_active then
      raise exception 'protected account fields' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_privileges() from public, anon, authenticated;
create trigger guard_profile_privileges before insert or update on public.user_profiles
for each row execute function public.guard_profile_privileges();

create or replace function public.is_account_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_profiles
    where id = auth.uid() and is_active is true);
$$;
revoke all on function public.is_account_active() from public, anon;
grant execute on function public.is_account_active() to authenticated, service_role;

create policy active_profile_updates on public.user_profiles as restrictive
for update to authenticated using ((select public.is_account_active()))
with check ((select public.is_account_active()));

-- Restrictive policies intersect existing ownership/sharing policies, including
-- writes made directly with an access token that predates account deactivation.
-- The profile remains readable so authentication can explain a disabled account.
do $$
declare target record;
begin
  for target in select n.nspname, c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relrowsecurity and c.relkind = 'r'
      and ((n.nspname = 'public' and c.relname <> 'user_profiles')
        or (n.nspname = 'storage' and c.relname = 'objects'))
  loop
    execute format('create policy active_account_required on %I.%I as restrictive
      for all to authenticated using ((select public.is_account_active()))
      with check ((select public.is_account_active()))', target.nspname, target.relname);
  end loop;
end $$;

-- Resolve grants under a pinned definer to avoid a sets/shares RLS recursion.
create or replace function public.has_limited_set_grant(p_set_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_account_active() and exists (
    select 1 from public.problem_set_shares s
    where s.problem_set_id = p_set_id
      and lower(s.shared_with_email) = lower(coalesce(auth.jwt()->>'email', ''))
      and coalesce(auth.jwt()->>'email', '') <> '');
$$;
revoke all on function public.has_limited_set_grant(uuid) from public, anon;
grant execute on function public.has_limited_set_grant(uuid) to authenticated, service_role;
alter policy problem_sets_select_policy on public.problem_sets using (
  user_id = (select auth.uid()) or sharing_level = 'public'
  or (sharing_level = 'limited' and public.has_limited_set_grant(id)));

-- A disabled account cannot mint/refresh credentials for a service-backed API.
create or replace function public.revoke_disabled_account_credentials()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_active is false and old.is_active is distinct from false then
    update public.user_api_tokens set revoked_at = now() where user_id = new.id and revoked_at is null;
    update public.oauth_tokens set revoked_at = now() where user_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;
revoke all on function public.revoke_disabled_account_credentials() from public, anon, authenticated;
create trigger revoke_disabled_account_credentials after update of is_active on public.user_profiles
for each row execute function public.revoke_disabled_account_credentials();

-- First administrator is an explicit service-only operation, never a signup
-- field or an automatic promotion of an arbitrary existing user.
create or replace function public.bootstrap_super_admin(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(61012001);
  if exists (select 1 from public.user_profiles where user_role = 'super_admin') then
    raise exception 'A super administrator already exists';
  end if;
  update public.user_profiles set user_role = 'super_admin'
    where id = p_user_id and is_active is true;
  if not found then raise exception 'Active profile not found'; end if;
end $$;
revoke all on function public.bootstrap_super_admin(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_super_admin(uuid) to service_role;

-- SECURITY DEFINER RPCs bypass table RLS. Preserve their signatures, owners,
-- grants and search paths, but check a caller's current account before the
-- original body runs. Service jobs without an end-user JWT retain their access.
create or replace function public.require_active_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_account_active() then
    raise exception 'Account is disabled' using errcode = '42501';
  end if;
end $$;
revoke all on function public.require_active_account() from public;
grant execute on function public.require_active_account() to anon, authenticated, service_role;

do $$
declare target record; guarded text;
begin
  for target in select p.oid, p.prosrc, l.lanname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
      and p.prorettype <> 'trigger'::regtype
      and p.proname not in ('is_account_active', 'has_limited_set_grant', 'require_active_account')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  loop
    if target.lanname = 'sql' then
      guarded := E'select public.require_active_account();\n' || target.prosrc;
    elsif target.lanname = 'plpgsql' then
      guarded := regexp_replace(target.prosrc, E'(^|\\n)([[:blank:]]*begin[[:blank:]]*\\n)',
        E'\\1\\2  perform public.require_active_account();\n', 'i');
      if guarded = target.prosrc then
        raise exception 'Missing account guard insertion point for %', target.oid::regprocedure;
      end if;
    else
      raise exception 'Unhandled exposed definer language for %', target.oid::regprocedure;
    end if;
    execute replace(pg_get_functiondef(target.oid), target.prosrc, guarded);
  end loop;
end $$;
