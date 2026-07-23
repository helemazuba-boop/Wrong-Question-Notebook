\set ON_ERROR_STOP on

do $$
begin
  if exists (
    select 1
    from public.esp32_devices
    group by upper(mac_address)
    having count(*) > 1
  ) then
    raise exception 'duplicate ESP32 MAC/hardware IDs must be resolved before migration';
  end if;

  if exists (
    select 1
    from public.esp32_devices
    where access_token_hash is null
       or access_token_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid ESP32 access_token_hash rows found';
  end if;

  if to_regclass('public.device_claims') is null
     or to_regclass('public.esp32_request_idempotency') is null then
    raise exception 'device-control v3 migration is not applied on the source';
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
    raise exception 'self-hosted security hardening is not applied: unsafe definer search_path';
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
    raise exception 'self-hosted security hardening is not applied: definer executable by PUBLIC';
  end if;
end
$$;

select extname, extversion
from pg_extension
order by extname;
