-- The device settings page is authoritative for its own automatic-sync
-- cadence. Persist the value only so protocol-v3 can echo it to old/new
-- clients consistently; the server never invents a new cadence during sync.

alter table public.esp32_devices
  add column if not exists auto_sync_interval_minutes integer not null default 60;

alter table public.esp32_devices
  drop constraint if exists esp32_devices_auto_sync_interval_valid;

alter table public.esp32_devices
  add constraint esp32_devices_auto_sync_interval_valid
  check (auto_sync_interval_minutes in (0, 15, 30, 60, 240));

comment on column public.esp32_devices.auto_sync_interval_minutes is
  'Last locally-authoritative automatic sync interval reported by the device.';
