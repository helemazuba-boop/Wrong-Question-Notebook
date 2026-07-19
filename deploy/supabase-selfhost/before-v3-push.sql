\set ON_ERROR_STOP on

-- Run this against the old Cloud database before applying
-- 20260719000000_esp32_device_control_v3.sql. The v3 migration promotes the
-- normalized MAC address to a globally unique hardware identity.
do $$
begin
  if exists (
    select 1
    from public.esp32_devices
    group by upper(mac_address)
    having count(*) > 1
  ) then
    raise exception 'duplicate ESP32 MAC/hardware IDs must be resolved before v3';
  end if;

  if exists (
    select 1
    from public.esp32_devices
    where access_token_hash is null
       or access_token_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid ESP32 access_token_hash rows found';
  end if;
end
$$;

select count(*) as validated_device_count
from public.esp32_devices;
