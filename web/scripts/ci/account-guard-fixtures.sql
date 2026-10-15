-- Only used by account-guard-migration-test.py inside an isolated transaction.
begin;
insert into auth.users (id, email) values
('a1210000-0000-4000-8000-000000000001', 'guard-active@example.invalid'),
('a1210000-0000-4000-8000-000000000002', 'guard-inactive@example.invalid');
update public.user_profiles set is_active = false
where id = 'a1210000-0000-4000-8000-000000000002';

create function public.account_guard_lf_fixture()
returns integer language plpgsql security definer set search_path = ''
as E'begin\n  return 41;\nend;';
create function public.account_guard_crlf_fixture()
returns integer language plpgsql security definer set search_path = ''
as E'declare\r\n  answer integer := 42;\r\nBEGIN \t\r\n  return answer;\r\nend;';
create function public.account_guard_sql_fixture()
returns integer language sql security definer set search_path = '' as $$select 43;$$;
revoke all on function public.account_guard_lf_fixture(),
  public.account_guard_crlf_fixture(), public.account_guard_sql_fixture() from public;
grant execute on function public.account_guard_lf_fixture(),
  public.account_guard_crlf_fixture(), public.account_guard_sql_fixture()
  to authenticated, service_role;

-- Reproduce the reported failure using the real historical RPC, with its guard
-- removed and its stored body converted to CRLF. No checked-in SQL is rewritten.
do $$
declare target record; original text;
begin
  select p.oid, p.prosrc into strict target from pg_proc p
  where p.oid = 'public.record_note_study_observation_v1(uuid,uuid,text,uuid,bigint,uuid,text,text,timestamp with time zone)'::regprocedure;
  original := replace(target.prosrc, E'\r\n', E'\n');
  original := replace(original, E'  perform public.require_active_account();\n', '');
  original := replace(original, E'\n', E'\r\n');
  execute replace(pg_get_functiondef(target.oid), target.prosrc, original);
end $$;
-- Reproduce databases where this legacy RPC remains exposed, as in the report.
grant execute on function public.record_note_study_observation_v1(
  uuid,uuid,text,uuid,bigint,uuid,text,text,timestamp with time zone
) to authenticated;

create temporary table account_guard_metadata as
select p.oid, p.proowner, p.proacl, p.proconfig, p.proargnames, p.proargtypes, p.prorettype
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and p.prokind = 'f';

-- APPLY_REAL_ACCOUNT_GUARD_MIGRATION

do $$
begin
  if exists (
    select 1 from account_guard_metadata before join pg_proc after on before.oid = after.oid
    where row(before.proowner, before.proacl, before.proconfig, before.proargnames,
      before.proargtypes, before.prorettype) is distinct from
      row(after.proowner, after.proacl, after.proconfig, after.proargnames,
      after.proargtypes, after.prorettype)
  ) then
    raise exception 'Account guard changed function ownership, ACL, settings or signature';
  end if;
  if strpos((select prosrc from pg_proc where oid =
    'public.record_note_study_observation_v1(uuid,uuid,text,uuid,bigint,uuid,text,text,timestamp with time zone)'::regprocedure), E'\r\n') = 0 then
    raise exception 'Historical CRLF body was not exercised';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1210000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
begin
  if public.account_guard_lf_fixture() <> 41
    or public.account_guard_crlf_fixture() <> 42
    or public.account_guard_sql_fixture() <> 43 then
    raise exception 'Account guard changed active-account function results';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"a1210000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
declare statement text;
begin
  foreach statement in array array[
    'select public.account_guard_lf_fixture()',
    'select public.account_guard_crlf_fixture()',
    'select public.account_guard_sql_fixture()',
    'select public.record_note_study_observation_v1(null,null,''invalid'',null,null,null,''reading'',''complete'',now())'
  ] loop
    begin
      execute statement;
      raise exception 'Account guard allowed an inactive account: %', statement;
    exception when sqlstate '42501' then
      if sqlerrm <> 'Account is disabled' then raise; end if;
    end;
  end loop;
end $$;

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  if public.account_guard_lf_fixture() <> 41
    or public.account_guard_crlf_fixture() <> 42
    or public.account_guard_sql_fixture() <> 43 then
    raise exception 'Account guard blocked a service job without an end-user JWT';
  end if;
end $$;
rollback;
\echo PASS: actual account guard migration accepts LF/CRLF and preserves authorization, results and function metadata
