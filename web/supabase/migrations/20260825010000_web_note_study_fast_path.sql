-- Web Note study fast path.
--
-- Keep the device-facing note-study-v1 observation contract unchanged while
-- allowing the Web client to persist an observation and receive the complete
-- next render state in one PostgREST round trip.

create or replace function public.get_web_note_study_session_v2(
  p_user_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.study_sessions%rowtype;
  v_candidate jsonb;
  v_note public.notebook_notes%rowtype;
  v_read public.note_read_state%rowtype;
  v_notebook_title text;
  v_notebook_titles jsonb := '[]'::jsonb;
  v_assets jsonb := '[]'::jsonb;
  v_linked_problem jsonb := 'null'::jsonb;
  v_current_item jsonb := 'null'::jsonb;
  v_opened_count bigint := 0;
  v_completed_count bigint := 0;
  v_skipped_count bigint := 0;
begin
  if p_user_id is null or p_session_id is null then
    raise exception using errcode = '22023', message = 'INVALID_WEB_NOTE_SESSION';
  end if;

  select * into v_session
  from public.study_sessions session_row
  where session_row.id = p_session_id
    and session_row.user_id = p_user_id
    and session_row.device_id is null
    and session_row.domain = 'note';

  if not found then
    raise exception using errcode = 'P0002', message = 'WEB_NOTE_SESSION_NOT_FOUND';
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(coalesce(notebook.title, '已移除笔记本')) order by scoped.ordinality),
    '[]'::jsonb
  ) into v_notebook_titles
  from jsonb_array_elements_text(
    coalesce(v_session.scope -> 'notebook_ids', '[]'::jsonb)
  ) with ordinality scoped(notebook_id, ordinality)
  left join public.notebooks notebook
    on notebook.id = scoped.notebook_id::uuid
   and notebook.user_id = p_user_id;

  select
    count(*) filter (where observation.action = 'opened'),
    count(*) filter (where observation.action = 'read_completed'),
    count(*) filter (where observation.action = 'skipped')
  into v_opened_count, v_completed_count, v_skipped_count
  from public.study_observations observation
  where observation.user_id = p_user_id
    and observation.session_id = p_session_id;

  if v_session.next_sequence < v_session.candidate_count then
    v_candidate := v_session.candidate_items -> (v_session.next_sequence::integer);
  end if;

  if v_candidate is not null then
    select notebook.title into v_notebook_title
    from public.notebooks notebook
    where notebook.id = (v_candidate ->> 'notebook_id')::uuid
      and notebook.user_id = p_user_id;

    select * into v_note
    from public.notebook_notes note
    where note.id = (v_candidate ->> 'item_id')::uuid
      and note.user_id = p_user_id
      and note.archived_at is null;

    if not found then
      v_current_item := jsonb_build_object(
        'available', false,
        'item_id', (v_candidate ->> 'item_id')::uuid,
        'notebook_id', (v_candidate ->> 'notebook_id')::uuid,
        'notebook_title', coalesce(v_notebook_title, '已移除笔记本'),
        'ordinal', (v_candidate ->> 'ordinal')::integer,
        'title', '笔记已移除',
        'content', '这篇笔记在阅读会话创建后被删除或归档。跳过后可继续。',
        'content_format', 'plain_text_v1',
        'source', 'user',
        'assets', '[]'::jsonb,
        'revision', 0,
        'linked_problem', null,
        'read_state', jsonb_build_object(
          'state', 'unread',
          'last_opened_at', null,
          'last_completed_at', null,
          'completed_count', 0
        )
      );
    else
      select * into v_read
      from public.note_read_state read_state
      where read_state.user_id = p_user_id
        and read_state.note_id = v_note.id;

      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'path', asset.value ->> 'path',
            'image_id', asset.value ->> 'image_id',
            'display_path', coalesce(asset.value ->> 'display_path', asset.value ->> 'path'),
            'preview_path', coalesce(asset.value ->> 'preview_path', asset.value ->> 'path')
          ) order by asset.ordinality
        ),
        '[]'::jsonb
      ) into v_assets
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_note.assets) = 'array' then v_note.assets
          else '[]'::jsonb
        end
      ) with ordinality asset(value, ordinality)
      where jsonb_typeof(asset.value) = 'object'
        and jsonb_typeof(asset.value -> 'path') = 'string'
        and jsonb_typeof(asset.value -> 'image_id') = 'string';

      if v_note.linked_problem_id is not null then
        select jsonb_build_object(
          'problem_id', problem.id,
          'problem_set_id', problem_link.problem_set_id,
          'subject_id', problem.subject_id,
          'title', problem.title,
          'status', problem.status
        ) into v_linked_problem
        from public.problems problem
        left join lateral (
          select link.problem_set_id
          from public.problem_set_problems link
          where link.problem_id = problem.id
          limit 1
        ) problem_link on true
        where problem.id = v_note.linked_problem_id
          and problem.user_id = p_user_id;
      end if;

      v_current_item := jsonb_build_object(
        'available', true,
        'item_id', v_note.id,
        'notebook_id', v_note.notebook_id,
        'notebook_title', coalesce(v_notebook_title, '已移除笔记本'),
        'ordinal', (v_candidate ->> 'ordinal')::integer,
        'title', v_note.title,
        'content', v_note.content,
        'content_format', coalesce(v_note.content_format, 'plain_text_v1'),
        'source', v_note.source,
        'assets', v_assets,
        'revision', coalesce(v_note.revision, 1),
        'linked_problem', v_linked_problem,
        'read_state', jsonb_build_object(
          'state', case
            when v_read.last_completed_at is not null then 'completed'
            when v_read.last_opened_at is not null then 'reading'
            else 'unread'
          end,
          'last_opened_at', v_read.last_opened_at,
          'last_completed_at', v_read.last_completed_at,
          'completed_count', coalesce(v_read.completed_count, 0)
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'session_id', v_session.id,
    'mode', v_session.mode,
    'status', v_session.status,
    'notebook_ids', coalesce(v_session.scope -> 'notebook_ids', '[]'::jsonb),
    'notebook_titles', v_notebook_titles,
    'candidate_count', v_session.candidate_count,
    'next_sequence', v_session.next_sequence,
    'started_at', v_session.started_at,
    'last_activity_at', v_session.last_activity_at,
    'expires_at', v_session.expires_at,
    'device_id', v_session.device_id,
    'current_note_id', case
      when v_current_item = 'null'::jsonb then null
      else v_current_item -> 'item_id'
    end,
    'current_note_title', case
      when v_current_item = 'null'::jsonb then null
      else v_current_item -> 'title'
    end,
    'current_item', v_current_item,
    'result', jsonb_build_object(
      'opened_count', coalesce(v_opened_count, 0),
      'completed_count', coalesce(v_completed_count, 0),
      'skipped_count', coalesce(v_skipped_count, 0)
    )
  );
end;
$$;

revoke all on function public.get_web_note_study_session_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_web_note_study_session_v2(uuid, uuid)
  to service_role;

create or replace function public.record_web_note_study_observation_v2(
  p_user_id uuid,
  p_request_id text,
  p_session_id uuid,
  p_sequence bigint,
  p_item_id uuid,
  p_action text,
  p_mode text,
  p_occurred_at timestamptz,
  p_skip boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_observation jsonb;
  v_session jsonb;
  v_existing public.study_observations%rowtype;
begin
  begin
    if p_skip then
      v_observation := public.skip_note_study_observation_v1(
        p_user_id,
        null,
        p_request_id,
        p_session_id,
        p_sequence,
        p_item_id,
        p_action,
        p_mode,
        p_occurred_at
      );
    else
      v_observation := public.record_note_study_observation_v1(
        p_user_id,
        null,
        p_request_id,
        p_session_id,
        p_sequence,
        p_item_id,
        p_action,
        p_mode,
        p_occurred_at
      );
    end if;
  exception when others then
    if sqlerrm <> 'STUDY_SEQUENCE_ALREADY_APPLIED' then
      raise;
    end if;

    select * into v_existing
    from public.study_observations observation
    where observation.user_id = p_user_id
      and observation.device_id is null
      and observation.session_id = p_session_id
      and observation.sequence = p_sequence;

    if not found
       or v_existing.item_id <> p_item_id
       or v_existing.action <> p_action
       or v_existing.mode <> p_mode then
      raise exception using
        errcode = '22023',
        message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
    end if;

    v_observation := v_existing.result || jsonb_build_object('replayed', true);
  end;

  -- The base RPC holds the session row lock until this outer transaction ends,
  -- so Web completion can be folded into the same atomic operation without a
  -- second lifecycle request or a lock-order inversion.
  update public.study_sessions session_row
  set status = 'completed',
      ended_at = coalesce(session_row.ended_at, now()),
      last_activity_at = now(),
      updated_at = now()
  where session_row.id = p_session_id
    and session_row.user_id = p_user_id
    and session_row.device_id is null
    and session_row.domain = 'note'
    and session_row.next_sequence >= session_row.candidate_count
    and session_row.status <> 'completed';

  v_session := public.get_web_note_study_session_v2(p_user_id, p_session_id);
  return jsonb_build_object(
    'observation', v_observation,
    'session', v_session
  );
end;
$$;

revoke all on function public.record_web_note_study_observation_v2(
  uuid, text, uuid, bigint, uuid, text, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.record_web_note_study_observation_v2(
  uuid, text, uuid, bigint, uuid, text, text, timestamptz, boolean
) to service_role;

create or replace function public.get_recent_note_reads_v2(
  p_user_id uuid,
  p_notebook_id uuid default null,
  p_limit integer default 12
)
returns table (
  note_id uuid,
  notebook_id uuid,
  notebook_title text,
  note_title text,
  state text,
  last_opened_at timestamptz,
  last_completed_at timestamptz,
  completed_count bigint,
  actor text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    note.id as note_id,
    note.notebook_id,
    coalesce(notebook.title, '笔记本') as notebook_title,
    note.title as note_title,
    case
      when read_state.last_completed_at is not null then 'completed'
      when read_state.last_opened_at is not null then 'reading'
      else 'unread'
    end as state,
    read_state.last_opened_at,
    read_state.last_completed_at,
    read_state.completed_count,
    case
      when latest_observation.item_id is null then 'unknown'
      when latest_observation.device_id is null then 'web'
      else 'note4'
    end as actor
  from public.note_read_state read_state
  join public.notebook_notes note
    on note.id = read_state.note_id
   and note.user_id = p_user_id
   and note.archived_at is null
  left join public.notebooks notebook
    on notebook.id = note.notebook_id
  left join lateral (
    select observation.item_id, observation.device_id
    from public.study_observations observation
    where observation.user_id = p_user_id
      and observation.item_id = note.id
      and observation.action in ('opened', 'read_completed')
    order by observation.occurred_at desc
    limit 1
  ) latest_observation on true
  where read_state.user_id = p_user_id
    and read_state.last_opened_at is not null
    and (p_notebook_id is null or note.notebook_id = p_notebook_id)
  order by read_state.last_opened_at desc
  limit least(greatest(coalesce(p_limit, 12), 1), 40);
$$;

revoke all on function public.get_recent_note_reads_v2(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_recent_note_reads_v2(uuid, uuid, integer)
  to service_role;
