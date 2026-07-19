-- ESP32 device-control v3 foundations.
-- Additive only: legacy v1/v2 media and control routes remain untouched until
-- the coordinated M7 production cutover.

create extension if not exists pgcrypto;

alter table public.esp32_devices
  add column if not exists hardware_id text,
  add column if not exists config_revision bigint not null default 1,
  add column if not exists sync_cursor bigint not null default 0,
  add column if not exists protocol_capabilities jsonb not null default '[]'::jsonb,
  add column if not exists last_boot_id text;

update public.esp32_devices
set hardware_id = upper(mac_address)
where hardware_id is null;

alter table public.esp32_devices
  add constraint esp32_devices_config_revision_nonnegative
    check (config_revision >= 0) not valid,
  add constraint esp32_devices_sync_cursor_nonnegative
    check (sync_cursor >= 0) not valid,
  add constraint esp32_devices_protocol_capabilities_array
    check (jsonb_typeof(protocol_capabilities) = 'array') not valid;

alter table public.esp32_devices
  validate constraint esp32_devices_config_revision_nonnegative,
  validate constraint esp32_devices_sync_cursor_nonnegative,
  validate constraint esp32_devices_protocol_capabilities_array;

create unique index if not exists esp32_devices_hardware_id_idx
  on public.esp32_devices (hardware_id)
  where hardware_id is not null;

create table if not exists public.device_claims (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  boot_id text not null,
  hardware_id text not null,
  device_public_key text,
  firmware_version text not null,
  capabilities jsonb not null default '[]'::jsonb,
  display_code text,
  display_code_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'consumed', 'expired')),
  approved_by uuid references auth.users(id) on delete set null,
  device_id uuid references public.esp32_devices(id) on delete set null,
  sealed_credential jsonb,
  poll_interval_ms integer not null default 3000
    check (poll_interval_ms between 1000 and 30000),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_claims_capabilities_array
    check (jsonb_typeof(capabilities) = 'array'),
  constraint device_claims_display_code_shape
    check (display_code is null or display_code ~ '^[0-9]{8}$'),
  constraint device_claims_sealed_shape
    check (sealed_credential is null or jsonb_typeof(sealed_credential) = 'object'),
  unique (hardware_id, boot_id, request_id)
);

comment on column public.device_claims.display_code is
  'Short-lived 8-digit physical-device approval code. Never log this value; cleanup clears it after expiry/consumption.';
comment on column public.device_claims.sealed_credential is
  'Repeatable ECDH/HKDF/AES-GCM credential envelope; cleared after first authenticated bootstrap.';

create unique index if not exists device_claims_active_code_hash_idx
  on public.device_claims (display_code_hash)
  where status in ('pending', 'approved') and display_code_hash is not null;
create index if not exists device_claims_expiry_idx
  on public.device_claims (expires_at);
create index if not exists device_claims_device_idx
  on public.device_claims (device_id)
  where device_id is not null;

create table if not exists public.esp32_request_idempotency (
  device_id uuid not null references public.esp32_devices(id) on delete cascade,
  request_id text not null,
  endpoint text not null,
  request_fingerprint text not null,
  http_status integer not null check (http_status between 200 and 599),
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  primary key (device_id, request_id),
  constraint esp32_request_idempotency_response_object
    check (jsonb_typeof(response_body) = 'object')
);

create index if not exists esp32_request_idempotency_expiry_idx
  on public.esp32_request_idempotency (expires_at);

alter table public.device_claims enable row level security;
alter table public.esp32_request_idempotency enable row level security;

-- There are deliberately no user-facing table policies. Claim creation,
-- approval and idempotency are mediated by server routes using service_role.
revoke all on table public.device_claims from anon, authenticated;
revoke all on table public.esp32_request_idempotency from anon, authenticated;
grant all on table public.device_claims to service_role;
grant all on table public.esp32_request_idempotency to service_role;

create or replace function public.approve_device_claim_v3(
  p_claim_id uuid,
  p_user_id uuid,
  p_action text,
  p_device_name text,
  p_device_id uuid,
  p_access_token_hash text,
  p_sealed_credential jsonb
)
returns table(device_id uuid, sealed_credential jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.device_claims%rowtype;
  existing_device public.esp32_devices%rowtype;
begin
  if p_action not in ('add', 'restore') then
    raise exception using errcode = '22023', message = 'INVALID_ACTION';
  end if;

  select * into claim_row
  from public.device_claims
  where id = p_claim_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CLAIM_NOT_FOUND';
  end if;

  if claim_row.status = 'approved' then
    if claim_row.approved_by <> p_user_id then
      raise exception using errcode = '42501', message = 'CLAIM_OWNER_MISMATCH';
    end if;
    return query select claim_row.device_id, claim_row.sealed_credential;
    return;
  end if;

  if claim_row.status <> 'pending' or claim_row.expires_at <= now() then
    update public.device_claims
    set status = 'expired', display_code = null, display_code_hash = null, updated_at = now()
    where id = claim_row.id;
    raise exception using errcode = 'P0001', message = 'CLAIM_EXPIRED';
  end if;

  select * into existing_device
  from public.esp32_devices
  where hardware_id = claim_row.hardware_id
  limit 1
  for update;

  if p_action = 'restore' then
    if existing_device.id is null then
      raise exception using errcode = 'P0002', message = 'DEVICE_NOT_FOUND';
    end if;
    if existing_device.user_id <> p_user_id then
      raise exception using errcode = '42501', message = 'DEVICE_OWNED_BY_ANOTHER_USER';
    end if;
    if existing_device.id <> p_device_id then
      raise exception using errcode = '40001', message = 'DEVICE_CHANGED';
    end if;

    update public.esp32_devices
    set access_token_hash = p_access_token_hash,
        device_name = coalesce(nullif(p_device_name, ''), device_name),
        firmware_version = claim_row.firmware_version,
        protocol_capabilities = claim_row.capabilities,
        last_boot_id = claim_row.boot_id,
        last_protocol_version = 'v3',
        sync_cursor = 0
    where id = existing_device.id;
  else
    if existing_device.id is not null then
      raise exception using errcode = '23505', message = 'DEVICE_ALREADY_EXISTS';
    end if;

    insert into public.esp32_devices (
      id,
      user_id,
      mac_address,
      hardware_id,
      device_name,
      access_token_hash,
      firmware_version,
      protocol_capabilities,
      last_boot_id,
      last_protocol_version
    ) values (
      p_device_id,
      p_user_id,
      claim_row.hardware_id,
      claim_row.hardware_id,
      coalesce(nullif(p_device_name, ''), 'ESP32'),
      p_access_token_hash,
      claim_row.firmware_version,
      claim_row.capabilities,
      claim_row.boot_id,
      'v3'
    );
  end if;

  update public.device_claims
  set status = 'approved',
      approved_by = p_user_id,
      device_id = p_device_id,
      sealed_credential = p_sealed_credential,
      approved_at = now(),
      display_code = null,
      updated_at = now()
  where id = claim_row.id;

  return query select p_device_id, p_sealed_credential;
end;
$$;

revoke all on function public.approve_device_claim_v3(uuid, uuid, text, text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.approve_device_claim_v3(uuid, uuid, text, text, uuid, text, jsonb)
  to service_role;

create or replace function public.consume_device_claim_v3(p_device_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.device_claims
  set status = 'consumed',
      device_public_key = null,
      display_code_hash = null,
      sealed_credential = null,
      consumed_at = now(),
      updated_at = now()
  where device_id = p_device_id and status = 'approved';
$$;

revoke all on function public.consume_device_claim_v3(uuid)
  from public, anon, authenticated;
grant execute on function public.consume_device_claim_v3(uuid) to service_role;

create or replace function public.commit_device_control_response_v3(
  p_device_id uuid,
  p_request_id text,
  p_endpoint text,
  p_request_fingerprint text,
  p_http_status integer,
  p_response_body jsonb,
  p_firmware_version text,
  p_capabilities jsonb,
  p_boot_id text,
  p_seen_at timestamptz,
  p_last_sync_at timestamptz,
  p_ack_sync_cursor bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_endpoint not in ('bootstrap', 'sync') or
     p_http_status <> 200 or
     jsonb_typeof(p_response_body) <> 'object' or
     jsonb_typeof(p_capabilities) <> 'array' or
     p_ack_sync_cursor < 0 then
    raise exception using errcode = '22023', message = 'INVALID_CONTROL_COMMIT';
  end if;

  insert into public.esp32_request_idempotency (
    device_id,
    request_id,
    endpoint,
    request_fingerprint,
    http_status,
    response_body
  ) values (
    p_device_id,
    p_request_id,
    p_endpoint,
    p_request_fingerprint,
    p_http_status,
    p_response_body
  );

  update public.esp32_devices
  set firmware_version = p_firmware_version,
      protocol_capabilities = p_capabilities,
      last_boot_id = p_boot_id,
      last_protocol_version = 'v3',
      last_seen_at = p_seen_at,
      last_sync_at = coalesce(p_last_sync_at, last_sync_at),
      sync_cursor = greatest(sync_cursor, p_ack_sync_cursor)
  where id = p_device_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'DEVICE_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.commit_device_control_response_v3(
  uuid, text, text, text, integer, jsonb, text, jsonb, text,
  timestamptz, timestamptz, bigint
) from public, anon, authenticated;
grant execute on function public.commit_device_control_response_v3(
  uuid, text, text, text, integer, jsonb, text, jsonb, text,
  timestamptz, timestamptz, bigint
) to service_role;

create or replace function public.cleanup_device_control_v3()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer := 0;
begin
  update public.device_claims
  set status = 'expired',
      display_code = null,
      display_code_hash = null,
      device_public_key = null,
      sealed_credential = null,
      updated_at = now()
  where expires_at <= now() and status in ('pending', 'approved');
  get diagnostics affected = row_count;

  delete from public.device_claims where expires_at < now() - interval '1 day';
  delete from public.esp32_request_idempotency where expires_at <= now();
  return affected;
end;
$$;

revoke all on function public.cleanup_device_control_v3() from public, anon, authenticated;
grant execute on function public.cleanup_device_control_v3() to service_role;

comment on function public.approve_device_claim_v3(uuid, uuid, text, text, uuid, text, jsonb) is
  'Atomically binds an approved physical-device claim, token hash and repeatable sealed credential.';
comment on function public.consume_device_claim_v3(uuid) is
  'Clears claim key material after the device first authenticates successfully.';
comment on function public.commit_device_control_response_v3(
  uuid, text, text, text, integer, jsonb, text, jsonb, text,
  timestamptz, timestamptz, bigint
) is
  'Atomically stores the first v3 response and advances only the cursor acknowledged by the device.';
