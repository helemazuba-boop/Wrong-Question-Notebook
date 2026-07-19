-- Run after all migrations, inside a caller-owned transaction which is rolled
-- back after the assertions. No test identity or device may persist.

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '10000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'device-control-v3-contract@example.invalid',
  '',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.esp32_devices (
  id,
  user_id,
  mac_address,
  hardware_id,
  device_name,
  access_token_hash,
  firmware_version,
  config_revision,
  sync_cursor
) values (
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'AA:BB:CC:DD:EE:01',
  'AA:BB:CC:DD:EE:01',
  'contract-device',
  repeat('a', 64),
  '0.1.0-test',
  1,
  0
);

select public.commit_device_control_response_v3(
  '20000000-0000-4000-8000-000000000002',
  'req_contract_commit_0001',
  'sync',
  repeat('b', 64),
  200,
  '{"ok":true,"request_id":"req_contract_commit_0001"}'::jsonb,
  '0.1.0-test',
  '["sync.v3"]'::jsonb,
  'boot_contract_0001',
  now(),
  now(),
  5
);

do $$
declare
  stored_cursor bigint;
  replay_count integer;
  duplicate_rejected boolean := false;
begin
  select sync_cursor into stored_cursor
  from public.esp32_devices
  where id = '20000000-0000-4000-8000-000000000002';
  if stored_cursor <> 5 then
    raise exception 'acknowledged cursor was not committed: %', stored_cursor;
  end if;

  select count(*) into replay_count
  from public.esp32_request_idempotency
  where device_id = '20000000-0000-4000-8000-000000000002'
    and request_id = 'req_contract_commit_0001';
  if replay_count <> 1 then
    raise exception 'expected one idempotency row, got %', replay_count;
  end if;

  begin
    perform public.commit_device_control_response_v3(
      '20000000-0000-4000-8000-000000000002',
      'req_contract_commit_0001',
      'sync',
      repeat('b', 64),
      200,
      '{"ok":true,"request_id":"req_contract_commit_0001"}'::jsonb,
      '0.1.0-test',
      '["sync.v3"]'::jsonb,
      'boot_contract_0001',
      now(),
      now(),
      99
    );
  exception when unique_violation then
    duplicate_rejected := true;
  end;
  if not duplicate_rejected then
    raise exception 'duplicate request id was not rejected';
  end if;

  select sync_cursor into stored_cursor
  from public.esp32_devices
  where id = '20000000-0000-4000-8000-000000000002';
  if stored_cursor <> 5 then
    raise exception 'duplicate request mutated cursor: %', stored_cursor;
  end if;
end;
$$;
