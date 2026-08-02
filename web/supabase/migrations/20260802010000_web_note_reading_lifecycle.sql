-- Web Note reading lifecycle.
--
-- Web sessions are the existing note-study-v1 sessions with device_id NULL.
-- This RPC changes only their lifecycle; observations remain the sole source
-- of sequence advancement and note_read_state projection.

create index if not exists note_read_state_user_opened_idx
  on public.note_read_state (user_id, last_opened_at desc)
  where last_opened_at is not null;

create index if not exists note_read_state_user_updated_idx
  on public.note_read_state (user_id, updated_at desc);

create or replace function public.set_web_note_study_session_status_v1(
  p_user_id uuid,
  p_session_id uuid,
  p_status text
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.study_sessions%rowtype;
begin
  if p_user_id is null
     or p_session_id is null
     or p_status is null
     or p_status not in ('active', 'paused', 'completed', 'abandoned') then
    raise exception using
      errcode = '22023',
      message = 'INVALID_WEB_NOTE_SESSION_STATUS';
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.device_id is null
    and s.domain = 'note';

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'WEB_NOTE_SESSION_NOT_FOUND';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'note-session:' || p_user_id::text || ':web:' || v_session.mode,
      0::bigint
    )
  );

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.device_id is null
    and s.domain = 'note'
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'WEB_NOTE_SESSION_NOT_FOUND';
  end if;

  if v_session.status = 'completed' then
    if p_status = 'completed' then
      return v_session;
    end if;
    raise exception using
      errcode = '22023',
      message = 'WEB_NOTE_SESSION_COMPLETED';
  end if;

  if v_session.status = 'abandoned'
     and p_status in ('active', 'paused') then
    raise exception using
      errcode = '22023',
      message = 'WEB_NOTE_SESSION_ABANDONED';
  end if;

  if p_status = 'completed'
     and v_session.next_sequence < v_session.candidate_count then
    raise exception using
      errcode = '22023',
      message = 'WEB_NOTE_SESSION_INCOMPLETE';
  end if;

  if v_session.expires_at <= now() and p_status in ('active', 'paused') then
    raise exception using
      errcode = '22023',
      message = 'WEB_NOTE_SESSION_EXPIRED';
  end if;

  if p_status = 'active' then
    update public.study_sessions
    set status = 'abandoned',
        ended_at = now(),
        updated_at = now()
    where user_id = p_user_id
      and device_id is null
      and domain = 'note'
      and mode = v_session.mode
      and id <> p_session_id
      and status in ('active', 'paused');
  end if;

  update public.study_sessions
  set status = p_status,
      ended_at = case
        when p_status in ('completed', 'abandoned') then now()
        else null
      end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.set_web_note_study_session_status_v1(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.set_web_note_study_session_status_v1(
  uuid, uuid, text
) to service_role;
