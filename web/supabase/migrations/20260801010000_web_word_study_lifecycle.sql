-- Web Word study lifecycle.
--
-- Device sessions continue to use the existing v1 observation contract. Web
-- sessions are identified by device_id IS NULL and use this RPC for atomic
-- pause/resume/complete/abandon transitions. Resuming a session abandons any
-- other resumable Web session in the same mode so the dashboard has one
-- canonical continuation target.

create or replace function public.set_web_word_study_session_status_v1(
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
      message = 'INVALID_WEB_WORD_SESSION_STATUS';
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.device_id is null
    and s.domain = 'word';

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'WEB_WORD_SESSION_NOT_FOUND';
  end if;

  -- Match create_word_study_session_v1's actor+mode lock so a resume cannot
  -- race a new Web session or another resume into two active sessions.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'word-session:' || p_user_id::text || ':web:' || v_session.mode,
      0::bigint
    )
  );

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id
    and s.user_id = p_user_id
    and s.device_id is null
    and s.domain = 'word'
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'WEB_WORD_SESSION_NOT_FOUND';
  end if;

  if v_session.status = 'completed' then
    if p_status = 'completed' then
      return v_session;
    end if;
    raise exception using
      errcode = '22023',
      message = 'WEB_WORD_SESSION_COMPLETED';
  end if;

  if v_session.status = 'abandoned'
     and p_status in ('active', 'paused') then
    raise exception using
      errcode = '22023',
      message = 'WEB_WORD_SESSION_ABANDONED';
  end if;

  if p_status = 'completed'
     and v_session.next_sequence < v_session.candidate_count then
    raise exception using
      errcode = '22023',
      message = 'WEB_WORD_SESSION_INCOMPLETE';
  end if;

  if v_session.expires_at <= now() and p_status in ('active', 'paused') then
    raise exception using
      errcode = '22023',
      message = 'WEB_WORD_SESSION_EXPIRED';
  end if;

  if p_status = 'active' then
    update public.study_sessions
    set status = 'abandoned',
        ended_at = now(),
        updated_at = now()
    where user_id = p_user_id
      and device_id is null
      and domain = 'word'
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

revoke all on function public.set_web_word_study_session_status_v1(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.set_web_word_study_session_status_v1(
  uuid, uuid, text
) to service_role;
