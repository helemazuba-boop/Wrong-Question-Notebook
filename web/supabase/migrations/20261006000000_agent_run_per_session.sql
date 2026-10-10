-- Agent run ledger per session (symptom 2 of the bidi gap plan, item C6).
--
-- 20260930000000 made the in-flight claim per *device*: one run in flight per
-- device, so a second session's prompt was answered 409 run_in_progress while
-- the first was still streaming. A device is allowed to hold several sessions
-- and to have several of them running in the cloud -- only its live *display*
-- is single-flight. The claim was therefore too coarse by one dimension.
--
-- The lift is exactly one column on the unique index and one predicate on the
-- busy select. Everything else in the claim path is deliberately untouched:
-- the per-device advisory lock still serializes claims (which is what stops two
-- concurrent claims for the *same* session from both seeing "not busy"), the
-- lease sweep still retires a row that outlived the event cap, and the
-- (device_id, request_id) primary key is still the idempotency identity.
--
-- Why this is safe to apply over live data: the index being replaced is unique
-- on (device_id) alone among in_flight rows, so the most in_flight rows a
-- single device can hold today is ONE. A duplicate under the new (device_id,
-- session_id) key needs two in_flight rows for one device, which the old index
-- already forbids -- see the probe recorded in doc/1005, "2026-10-06 C6 落地".
-- No pre-migration cleanup of in_flight rows is required.
--
-- session_id is `not null` (unlike a column that could be), so the new key has
-- no nulls-distinct escape hatch: two in-flight rows for one pair are rejected
-- exactly as intended, not quietly allowed because one side was null.
--
-- The drop/create pair leaves a moment with no in-flight backstop at all. That
-- window is not load-bearing: the advisory lock inside the RPC is what
-- serializes claims, and this index is documented as a backstop rather than the
-- thing normal traffic hits. It cannot run `concurrently` because the
-- migration is wrapped in a transaction -- and that wrap is also what makes the
-- pair safe: if the create were to fail, the drop rolls back with it, so the
-- table is never left unbackstopped. Do not split these two statements, and do
-- not re-run the rollback direction through a bare `psql -f`, which autocommits
-- each statement and would leave the index gone if the create failed.

drop index if exists public.esp32_agent_run_requests_in_flight_idx;

create unique index esp32_agent_run_requests_in_flight_idx
  on public.esp32_agent_run_requests (device_id, session_id)
  where state = 'in_flight';

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

  -- The only change in this function: "busy" used to ask whether the device had
  -- any run in flight. It now asks whether it has one in flight *for this
  -- session*. A device running two sessions therefore gets two independent
  -- claims, while a second prompt into the same session still collides -- which
  -- is the invariant the old wording was really trying to protect.
  select * into busy
  from public.esp32_agent_run_requests
  where device_id = p_device_id
    and session_id = p_session_id
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

comment on function public.claim_agent_run_request_v3(uuid, text, text, text, integer) is
  'Claims or replays an agent run: claimed/attached/stale/completed/failed/conflict/busy, self-healing expired in-flight rows. Busy means in flight for this (device, session) pair.';
