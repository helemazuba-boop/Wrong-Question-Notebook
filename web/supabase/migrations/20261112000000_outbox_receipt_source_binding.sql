-- Maintenance-only opt-in. The device reads its own MAC; the server binds it
-- to the authenticated actor and the canonical facts in the same STABLE read
-- snapshot. This proves a database binding, never repair authority or a
-- cryptographic hardware attestation. The existing five-argument RPC remains.
create function public.lookup_device_outbox_receipts_bound_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_domain text,
  p_session_id uuid,
  p_request_ids text[],
  p_source_mac text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_result jsonb;
begin
  if p_source_mac is null or p_source_mac !~ '^[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_SOURCE_MAC';
  end if;

  select public.lookup_device_outbox_receipts_v1(
    p_user_id, p_device_id, p_domain, p_session_id, p_request_ids
  ) into v_result
  from public.esp32_devices d
  where d.id = p_device_id and d.user_id = p_user_id
    and d.mac_address ~* '^([0-9a-f]{12}|([0-9a-f]{2}:){5}[0-9a-f]{2})$'
    and pg_catalog.replace(pg_catalog.lower(d.mac_address), ':', '') = p_source_mac;

  return v_result;
end;
$$;

revoke all on function public.lookup_device_outbox_receipts_bound_v1(uuid, uuid, text, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.lookup_device_outbox_receipts_bound_v1(uuid, uuid, text, uuid, text[], text)
  to service_role;
