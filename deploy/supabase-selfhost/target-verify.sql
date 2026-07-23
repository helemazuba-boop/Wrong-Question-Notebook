\set ON_ERROR_STOP on

do $$
declare
  required_table text;
begin
  foreach required_table in array array[
    'public.user_profiles',
    'public.problems',
    'public.todos',
    'public.esp32_devices',
    'public.device_claims',
    'public.esp32_request_idempotency'
  ]
  loop
    if to_regclass(required_table) is null then
      raise exception 'required table missing: %', required_table;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'esp32_devices'
      and column_name = 'access_token'
  ) then
    raise exception 'plaintext esp32_devices.access_token column still exists';
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname in (
        'user_profiles', 'problems', 'todos', 'esp32_devices',
        'device_claims', 'esp32_request_idempotency'
      )
      and not c.relrowsecurity
  ) then
    raise exception 'required public table without RLS';
  end if;

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
