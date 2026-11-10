-- Run only on an isolated OAuth-migration-complete database. No pgTAP needed.
begin;
set local plpgsql.check_asserts = on;

insert into auth.users(id) values ('f0111111-1111-4111-8111-111111111111');
insert into public.oauth_clients(client_id, client_name, redirect_uris, grant_types, response_types)
values ('wqn_device_sql_test', 'SQL Device Test', '{}',
  array['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], '{}');

do $$
declare
  response jsonb;
  device_id uuid;
  count_rows integer;
begin
  assert not has_table_privilege('anon', 'public.oauth_device_authorizations', 'SELECT');
  assert not has_table_privilege('authenticated', 'public.oauth_device_authorizations', 'SELECT');
  assert not has_table_privilege('authenticated', 'public.oauth_device_authorizations', 'UPDATE');
  assert has_table_privilege('service_role', 'public.oauth_device_authorizations', 'SELECT');
  assert not has_function_privilege('anon', 'public.oauth_poll_device_authorization(text,text,text,text,text,integer,integer)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.oauth_poll_device_authorization(text,text,text,text,text,integer,integer)', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.oauth_poll_device_authorization(text,text,text,text,text,integer,integer)', 'EXECUTE');

  begin
    insert into public.oauth_clients(client_id, client_name, redirect_uris)
      values ('wqn_invalid_code_test', 'Invalid code client', '{}');
    raise exception 'Code client without a redirect was accepted';
  exception when check_violation then null;
  end;

  insert into public.oauth_device_authorizations(client_id, device_code_hash, user_code_hash,
    scope, resource, expires_at, next_poll_at)
    values ('wqn_device_sql_test', repeat('a',64), repeat('b',64), 'mcp:all',
      'https://wqn.example/api/mcp', now() + interval '10 minutes', now() - interval '1 second')
    returning id into device_id;

  response := public.oauth_poll_device_authorization(repeat('a',64), 'other_client',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'invalid_grant', 'Client binding failed';
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://other.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'invalid_target', 'Resource binding failed';

  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'authorization_pending';
  assert (select count(*) = 0 from public.oauth_tokens where client_id = 'wqn_device_sql_test');
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'slow_down';
  assert (select interval_seconds = 10 and next_poll_at > clock_timestamp()
    from public.oauth_device_authorizations where id = device_id);

  update public.oauth_device_authorizations set status = 'denied' where id = device_id;
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'access_denied';
  update public.oauth_device_authorizations set status = 'pending', expires_at = now() - interval '1 second'
    where id = device_id;
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'error' = 'expired_token';

  update public.oauth_device_authorizations set status = 'approved',
    user_id = 'f0111111-1111-4111-8111-111111111111',
    expires_at = now() + interval '10 minutes', next_poll_at = now() - interval '1 second'
    where id = device_id;
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
  assert response->>'scope' = 'mcp:all';
  assert response->>'user_id' = 'f0111111-1111-4111-8111-111111111111';
  assert (select status = 'consumed' and consumed_at is not null
    from public.oauth_device_authorizations where id = device_id);
  assert (select count(*) = 1 from public.oauth_tokens where client_id = 'wqn_device_sql_test');
  assert (select resource = 'https://wqn.example/api/mcp' and
    access_token_expires_at between now() + interval '59 minutes' and now() + interval '61 minutes' and
    refresh_token_expires_at between now() + interval '89 days' and now() + interval '91 days'
    from public.oauth_tokens where client_id = 'wqn_device_sql_test');
  response := public.oauth_poll_device_authorization(repeat('a',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('e',64), repeat('f',64), 3600, 7776000);
  assert response->>'error' = 'invalid_grant', 'Consumed device code was reused';
  assert (select count(*) = 1 from public.oauth_tokens where client_id = 'wqn_device_sql_test');

  -- Token insertion failure must leave the approved code redeemable.
  insert into public.oauth_device_authorizations(client_id, device_code_hash, user_code_hash,
    user_id, status, scope, resource, expires_at, next_poll_at)
    values ('wqn_device_sql_test', repeat('e',64), repeat('f',64),
      'f0111111-1111-4111-8111-111111111111', 'approved', 'mcp:all',
      'https://wqn.example/api/mcp', now() + interval '10 minutes', now() - interval '1 second')
    returning id into device_id;
  begin
    perform public.oauth_poll_device_authorization(repeat('e',64), 'wqn_device_sql_test',
      'https://wqn.example/api/mcp', repeat('c',64), repeat('d',64), 3600, 7776000);
    raise exception 'Duplicate token hashes did not fail';
  exception when unique_violation then null;
  end;
  assert (select status = 'approved' and consumed_at is null
    from public.oauth_device_authorizations where id = device_id), 'Failed issuance consumed the code';
  response := public.oauth_poll_device_authorization(repeat('e',64), 'wqn_device_sql_test',
    'https://wqn.example/api/mcp', repeat('1',64), repeat('2',64), 3600, 7776000);
  assert response->>'scope' = 'mcp:all';

  -- A decision can only be applied once by the production conditional UPDATE.
  update public.oauth_device_authorizations set status = 'denied'
    where id = device_id and status = 'pending' and expires_at > clock_timestamp();
  get diagnostics count_rows = row_count;
  assert count_rows = 0, 'A consumed grant accepted another decision';
  raise notice 'OAuth device SQL assertions passed';
end;
$$;
rollback;
