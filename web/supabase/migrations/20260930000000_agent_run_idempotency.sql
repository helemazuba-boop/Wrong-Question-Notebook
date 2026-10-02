-- Agent run idempotency (P2): one in-flight OpenCode run per device, keyed by a
-- device-generated request_id. Claim/complete are the only writers, and the
-- claim self-heals an expired in-flight row from its own lease, so a crashed
-- route never wedges the device (no cron, no TTL scheduler, no external job).

create table if not exists public.esp32_agent_run_requests (
  device_id uuid not null references public.esp32_devices(id) on delete cascade,
  request_id text not null,
  session_id text not null,
  request_fingerprint text not null,
  state text not null default 'in_flight'
    check (state in ('in_flight', 'completed', 'failed')),
  error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  primary key (device_id, request_id)
);

comment on table public.esp32_agent_run_requests is
  'Idempotency ledger for OpenCode agent runs: one in-flight run per device, replayed by request_id.';
comment on column public.esp32_agent_run_requests.created_at is
  'Claim time. The in-flight lease is measured from here (event absolute cap + slack).';
comment on column public.esp32_agent_run_requests.expires_at is
  'Retention window only; nothing in the claim path depends on it.';

-- A device has at most one run in flight. The claim RPC serializes per device
-- with an advisory lock, so this index is a backstop, not a 23505 source.
create unique index if not exists esp32_agent_run_requests_in_flight_idx
  on public.esp32_agent_run_requests (device_id)
  where state = 'in_flight';

create index if not exists esp32_agent_run_requests_expiry_idx
  on public.esp32_agent_run_requests (expires_at);

alter table public.esp32_agent_run_requests enable row level security;

-- Deliberately no user-facing policies: only the run route (service_role) reads
-- or writes this table.
revoke all on table public.esp32_agent_run_requests from anon, authenticated;
grant all on table public.esp32_agent_run_requests to service_role;

create or replace function public.claim_agent_run_request_v3(
  p_device_id uuid,
  p_request_id text,
  p_session_id text,
  p_request_fingerprint text,
  p_lease_seconds integer
)
returns table(result text, error_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.esp32_agent_run_requests%rowtype;
  busy public.esp32_agent_run_requests%rowtype;
begin
  if p_request_id !~ '^[0-9a-f]{16}$' or
     p_session_id = '' or
     p_request_fingerprint = '' or
     p_lease_seconds <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_RUN_CLAIM';
  end if;

  -- Serialize claims per device so every check below races against nothing and
  -- the partial unique index is never hit in normal operation.
  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text, 0));

  -- Lease self-healing: a run that outlived the event absolute cap plus slack
  -- cannot still be running, so its row stops blocking the device. This sweep
  -- is the only recovery path; it deliberately runs before adjudication.
  update public.esp32_agent_run_requests
  set state = 'failed',
      error_code = 'stale'
  where device_id = p_device_id
    and state = 'in_flight'
    and created_at < now() - make_interval(secs => p_lease_seconds);

  select * into existing
  from public.esp32_agent_run_requests
  where device_id = p_device_id
    and request_id = p_request_id;

  if found then
    if existing.request_fingerprint <> p_request_fingerprint then
      return query select 'conflict'::text, null::text;
    elsif existing.state = 'in_flight' then
      return query select 'attached'::text, null::text;
    elsif existing.state = 'completed' then
      return query select 'completed'::text, null::text;
    elsif existing.error_code = 'stale' then
      -- The lease sweep retired this attempt; the retry owns the id now. The
      -- row is reused because (device_id, request_id) is the primary key.
      update public.esp32_agent_run_requests
      set state = 'in_flight',
          error_code = null,
          session_id = p_session_id,
          created_at = now(),
          expires_at = now() + interval '7 days'
      where device_id = p_device_id
        and request_id = p_request_id;
      return query select 'stale'::text, null::text;
    else
      return query select 'failed'::text, existing.error_code;
    end if;
    return;
  end if;

  select * into busy
  from public.esp32_agent_run_requests
  where device_id = p_device_id
    and state = 'in_flight'
  limit 1;

  if found then
    return query select 'busy'::text, null::text;
    return;
  end if;

  insert into public.esp32_agent_run_requests (
    device_id,
    request_id,
    session_id,
    request_fingerprint
  ) values (
    p_device_id,
    p_request_id,
    p_session_id,
    p_request_fingerprint
  );
  return query select 'claimed'::text, null::text;
end;
$$;

revoke all on function public.claim_agent_run_request_v3(
  uuid, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.claim_agent_run_request_v3(
  uuid, text, text, text, integer
) to service_role;

create or replace function public.complete_agent_run_request_v3(
  p_device_id uuid,
  p_request_id text,
  p_state text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_state not in ('completed', 'failed') then
    raise exception using errcode = '22023', message = 'INVALID_RUN_COMPLETE';
  end if;

  -- A no-op on a terminal row: the lease sweep may have already retired the
  -- attempt this write belongs to.
  update public.esp32_agent_run_requests
  set state = p_state,
      error_code = p_error_code
  where device_id = p_device_id
    and request_id = p_request_id
    and state = 'in_flight';
end;
$$;

revoke all on function public.complete_agent_run_request_v3(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_agent_run_request_v3(
  uuid, text, text, text
) to service_role;

comment on function public.claim_agent_run_request_v3(uuid, text, text, text, integer) is
  'Claims or replays an agent run: claimed/attached/stale/completed/failed/conflict/busy, self-healing expired in-flight rows.';
comment on function public.complete_agent_run_request_v3(uuid, text, text, text) is
  'Writes the terminal state of a claimed agent run; no-op when the row already left in_flight.';
