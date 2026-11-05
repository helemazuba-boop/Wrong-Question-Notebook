-- R-08 investigation only. No observation, projection, session, idempotency,
-- ACK or device metadata writes. A single SELECT supplies one MVCC snapshot.
create or replace function public.lookup_device_outbox_receipts_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_domain text,
  p_session_id uuid,
  p_request_ids text[]
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
  if p_user_id is null or p_device_id is null or p_session_id is null
     or p_domain is null or p_domain not in ('word', 'note')
     or p_request_ids is null or cardinality(p_request_ids) not between 1 and 64
     or array_ndims(p_request_ids) <> 1
     or exists (select 1 from unnest(p_request_ids) r(id)
       where id is null or id !~ '^[A-Za-z0-9_-]{16,64}$')
     or (select count(distinct id) from unnest(p_request_ids) r(id)) <> cardinality(p_request_ids) then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_RECEIPT_QUERY';
  end if;

  with owned_session as (
    select s.id, s.domain, s.mode, s.status, s.next_sequence, s.expires_at
    from public.study_sessions s
    join public.esp32_devices d on d.id = p_device_id and d.user_id = p_user_id
    join public.user_profiles u on u.id = p_user_id and u.is_active = true
    where s.id = p_session_id and s.user_id = p_user_id
      and s.device_id = p_device_id and s.domain = p_domain
  ), wanted as (
    select r.id, r.ordinal from unnest(p_request_ids) with ordinality r(id, ordinal)
  )
  select jsonb_build_object(
    'contract', 'outbox-reconciliation-v1',
    'read_at', statement_timestamp(),
    'actor', jsonb_build_object('user_id', p_user_id, 'device_id', p_device_id),
    'session', jsonb_build_object('session_id', s.id, 'domain', s.domain,
      'mode', s.mode, 'status', s.status, 'next_sequence', s.next_sequence, 'expires_at', s.expires_at),
    'receipts', (
      select jsonb_agg(jsonb_build_object(
        'request_id', w.id,
        'state', case when o.id is null then 'not_found'
                      when o.session_id <> s.id then 'conflict' else 'found' end,
        'observation', case when o.id is not null and o.session_id = s.id then
          jsonb_build_object('observation_id', o.id, 'request_id', o.request_id,
            'session_id', o.session_id, 'sequence', o.sequence, 'item_id', o.item_id,
            'action', o.action, 'mode', o.mode, 'occurred_at', o.occurred_at, 'created_at', o.created_at)
          else 'null'::jsonb end
      ) order by w.ordinal)
      from wanted w
      -- Look up the actor's original request identity before comparing session.
      -- An ID consumed by another session is a conflict, never "not found".
      left join public.study_observations o on o.user_id = p_user_id
        and o.device_id = p_device_id and o.request_id = w.id
    ),
    'repair_authorized', false
  ) into v_result from owned_session s;
  return v_result;
end;
$$;

revoke all on function public.lookup_device_outbox_receipts_v1(uuid, uuid, text, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.lookup_device_outbox_receipts_v1(uuid, uuid, text, uuid, text[])
  to service_role;
