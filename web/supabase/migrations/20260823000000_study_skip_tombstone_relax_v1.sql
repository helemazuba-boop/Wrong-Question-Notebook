-- Study skip tombstone relax (Candidate A', minimal tombstone contract).
--
-- The device outbox advances a terminally rejected observation by posting a
-- skip tombstone. The tombstone is an identity statement ("consume sequence N
-- of session S for item I"), not a business projection: the server already
-- hard-codes action='skipped' into the stored row and never reads p_action.
-- Yet the previous guards still demanded fully valid action/mode/occurred_at
-- values from the device, so a record whose original payload was rejected
-- *because* of a schema/visibility problem could not always be retired.
--
-- This migration relaxes both skip functions without changing their
-- signatures:
--
--   * p_action / p_mode / p_occurred_at are no longer validated; they may be
--     null. The stored tombstone keeps action='skipped', derives mode from
--     the locked study_sessions row (the session mode is authoritative), and
--     defaults occurred_at to now() with the same clamp the record path uses.
--   * The idempotent replay comparison drops mode (a placeholder mode on a
--     retry must not turn a replay into STUDY_REQUEST_ID_REUSED).
--   * The actor check drops mode as well (device_id alone identifies the
--     actor); mode consistency is inherited from the locked session row.
--
-- Identity fields stay strict: user_id, request_id shape, session_id,
-- sequence range, item_id.
--
-- Safe to re-apply: create or replace only, no table or constraint changes
-- (the stored values remain inside the existing table CHECK whitelists).

create or replace function public.skip_study_observation_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_request_id text,
  p_session_id uuid,
  p_sequence bigint,
  p_item_id uuid,
  p_action text,
  p_mode text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.study_sessions%rowtype;
  v_existing public.study_observations%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_occurred_at timestamptz;
  v_result jsonb;
begin
  if p_user_id is null
     or p_request_id is null
     or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null
     or p_sequence is null
     or p_sequence < 0
     or p_sequence > 9007199254740991
     or p_item_id is null then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || coalesce(p_device_id::text, 'web') || ':' || p_request_id,
      0::bigint
    )
  );

  select * into v_existing
  from public.study_observations o
  where o.user_id = p_user_id
    and o.device_id is not distinct from p_device_id
    and o.request_id = p_request_id;

  if found then
    if v_existing.session_id <> p_session_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.sequence <> p_sequence
       or v_existing.item_id <> p_item_id then
      raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.expires_at > now()
  for update;

  if not found
     or v_session.domain <> 'word'
     or v_session.status not in ('active', 'paused', 'abandoned') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    raise exception using errcode = '40001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

  v_occurred_at := least(
    now(),
    greatest(coalesce(p_occurred_at, now()), '2000-01-01'::timestamptz)
  );

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'session_id', p_session_id,
    'sequence', p_sequence,
    'item_id', p_item_id,
    'action', 'skipped',
    'progress', null,
    'projection_applied', false,
    'replayed', false
  );

  insert into public.study_observations (
    id, user_id, device_id, request_id, session_id, sequence,
    item_id, action, mode, occurred_at, result
  ) values (
    v_observation_id, p_user_id, p_device_id, p_request_id, p_session_id,
    p_sequence, p_item_id, 'skipped', v_session.mode, v_occurred_at, v_result
  );

  update public.study_sessions
  set next_sequence = next_sequence + 1,
      status = case when status = 'paused' then 'active' else status end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id;

  return v_result;
end;
$$;

revoke all on function public.skip_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.skip_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;

create or replace function public.skip_note_study_observation_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_request_id text,
  p_session_id uuid,
  p_sequence bigint,
  p_item_id uuid,
  p_action text,
  p_mode text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.study_sessions%rowtype;
  v_existing public.study_observations%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_occurred_at timestamptz;
  v_result jsonb;
begin
  if p_user_id is null
     or p_request_id is null
     or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null
     or p_sequence is null
     or p_sequence < 0
     or p_sequence > 9007199254740991
     or p_item_id is null then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || coalesce(p_device_id::text, 'web') || ':' || p_request_id,
      0::bigint
    )
  );

  select * into v_existing
  from public.study_observations o
  where o.user_id = p_user_id
    and o.device_id is not distinct from p_device_id
    and o.request_id = p_request_id;

  if found then
    if v_existing.session_id <> p_session_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.sequence <> p_sequence
       or v_existing.item_id <> p_item_id then
      raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.expires_at > now()
  for update;

  if not found
     or v_session.domain <> 'note'
     or v_session.status not in ('active', 'paused', 'abandoned') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    raise exception using errcode = '40001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

  v_occurred_at := least(
    now(),
    greatest(coalesce(p_occurred_at, now()), '2000-01-01'::timestamptz)
  );

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'session_id', p_session_id,
    'sequence', p_sequence,
    'item_id', p_item_id,
    'action', 'skipped',
    'progress', null,
    'projection_applied', false,
    'replayed', false
  );

  insert into public.study_observations (
    id, user_id, device_id, request_id, session_id, sequence,
    item_id, action, mode, occurred_at, result
  ) values (
    v_observation_id, p_user_id, p_device_id, p_request_id, p_session_id,
    p_sequence, p_item_id, 'skipped', v_session.mode, v_occurred_at, v_result
  );

  update public.study_sessions
  set next_sequence = next_sequence + 1,
      status = case when status = 'paused' then 'active' else status end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id;

  return v_result;
end;
$$;

revoke all on function public.skip_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.skip_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;
