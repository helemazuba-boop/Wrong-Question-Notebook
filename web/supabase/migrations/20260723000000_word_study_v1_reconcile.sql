-- Word Study v1 drift repair.
--
-- 20260720120000_word_study_v1.sql was edited after it had already been applied
-- to the linked remote database. Supabase tracks migrations by version id, so
-- the edited body (study_sessions.expires_at, candidate paging, and the current
-- RPC definitions that return projection_applied) never reached the deployed
-- database even though `supabase migration list` reports the version as applied
-- on both sides (it compares version ids, not file contents).
--
-- This forward migration re-applies the drifted delta idempotently and is safe
-- for `supabase db push`. It preserves existing session/observation/progress
-- rows.
--
--   * `create table if not exists` cannot add a column to an existing table, so
--     study_sessions.expires_at is added explicitly here first (the missing
--     column is what makes the candidate-page query fail with 42703 ->
--     WORD_STUDY_UNAVAILABLE 503 on the device).
--   * every remaining object from 20260720120000 (indexes, RLS, the
--     word_review_events columns, and all study functions) is then re-run
--     verbatim; each statement is `if not exists` / `create or replace`, so the
--     deployed functions are refreshed to return projection_applied.

alter table public.study_sessions
  add column if not exists expires_at timestamptz not null default (now() + interval '30 days');

create unique index if not exists study_sessions_actor_request_v1_uidx
  on public.study_sessions (
    user_id,
    coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    create_request_id
  );
create unique index if not exists study_observations_actor_request_v1_uidx
  on public.study_observations (
    user_id,
    coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    request_id
  );
create index if not exists study_sessions_user_activity_v1_idx
  on public.study_sessions (user_id, last_activity_at desc);
create index if not exists study_sessions_device_status_v1_idx
  on public.study_sessions (device_id, status, last_activity_at desc)
  where device_id is not null;
create index if not exists study_sessions_pack_retention_v1_idx
  on public.study_sessions (status, expires_at)
  where status in ('active', 'paused');
create index if not exists study_observations_session_sequence_v1_idx
  on public.study_observations (session_id, sequence);
create index if not exists study_observations_user_item_v1_idx
  on public.study_observations (user_id, item_id, occurred_at desc);

alter table public.study_sessions enable row level security;
alter table public.study_observations enable row level security;
revoke all on table public.study_sessions from anon, authenticated;
revoke all on table public.study_observations from anon, authenticated;
grant select on table public.study_sessions to authenticated;
grant select on table public.study_observations to authenticated;
grant all on table public.study_sessions to service_role;
grant all on table public.study_observations to service_role;

drop policy if exists study_sessions_owner_select_v1 on public.study_sessions;
create policy study_sessions_owner_select_v1 on public.study_sessions
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists study_observations_owner_select_v1 on public.study_observations;
create policy study_observations_owner_select_v1 on public.study_observations
for select to authenticated
using ((select auth.uid()) = user_id);

alter table public.word_review_events
  add column if not exists study_observation_id uuid references public.study_observations(id) on delete set null,
  add column if not exists request_id text,
  add column if not exists session_id uuid references public.study_sessions(id) on delete set null,
  add column if not exists sequence bigint;

create unique index if not exists word_review_events_observation_v1_uidx
  on public.word_review_events (study_observation_id)
  where study_observation_id is not null;
create index if not exists word_review_events_session_v1_idx
  on public.word_review_events (session_id)
  where session_id is not null;

create or replace function public.record_study_observation_v1(
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
  v_entry public.word_entries%rowtype;
  v_progress public.word_progress%rowtype;
  v_existing public.study_observations%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_progress_json jsonb := 'null'::jsonb;
  v_result jsonb;
  v_effective_at timestamptz;
  v_correct_streak integer;
  v_interval_days integer;
  v_next_status text;
  v_due_at timestamptz;
  v_subject_id uuid;
  v_problem_set_id uuid;
  v_problem_id uuid;
  v_wrong_problem_id uuid;
  v_legacy_outcome text;
  v_projection_applied boolean := false;
begin
  if p_user_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null or p_item_id is null
     or p_sequence < 0 or p_sequence > 9007199254740991
     or p_action not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
     or p_mode not in ('sequential', 'random', 'dictionary')
     or p_occurred_at is null then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;

  -- Serialize identical request IDs before touching session or progress state.
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
       or v_existing.item_id <> p_item_id
       or v_existing.action <> p_action
       or v_existing.mode <> p_mode
       or v_existing.occurred_at <> p_occurred_at then
      raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session
  from public.study_sessions s
  where s.id = p_session_id and s.user_id = p_user_id
    and s.expires_at > now()
  for update;

  -- A newly created session retires the previous one as `abandoned`, but
  -- already-durable offline observations from that session must still drain.
  -- Candidate snapshots are retained for this reconciliation window.
  if not found or v_session.domain <> 'word' or v_session.status not in ('active', 'paused', 'abandoned') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id or v_session.mode <> p_mode then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    -- A missing earlier observation is recoverable: the device must keep this
    -- head pending until the lower sequence arrives.
    raise exception using errcode = '40001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    -- A request with an already-consumed sequence and a new request_id cannot
    -- be made idempotent safely; the device quarantines only this observation.
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

  select e.* into v_entry
  from public.word_entries e
  join public.word_decks d on d.id = e.deck_id
  where e.id = p_item_id
    and d.is_active = true
    and d.archived_at is null
    and (d.is_system = true or d.user_id = p_user_id)
    and (
      jsonb_array_length(v_session.scope -> 'deck_ids') = 0
      or exists (
        select 1
        from jsonb_array_elements_text(v_session.scope -> 'deck_ids') scoped(deck_id)
        where scoped.deck_id::uuid = e.deck_id
      )
    );

  if not found then
    raise exception using errcode = '22023', message = 'STUDY_ITEM_NOT_VISIBLE';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_session.candidate_items) item
    where (item ->> 'item_id')::uuid = p_item_id
  ) then
    raise exception using errcode = '22023', message = 'STUDY_ITEM_NOT_IN_SESSION';
  end if;

  v_effective_at := least(
    now(),
    greatest(p_occurred_at, timestamptz '2000-01-01 00:00:00+00')
  );

  if p_action in ('known', 'unknown') then
    insert into public.word_progress (user_id, word_entry_id)
    values (p_user_id, p_item_id)
    on conflict (user_id, word_entry_id) do nothing;

    select * into v_progress
    from public.word_progress p
    where p.user_id = p_user_id and p.word_entry_id = p_item_id
    for update;

    if v_progress.last_reviewed_at is null
       or v_effective_at > v_progress.last_reviewed_at then
      v_projection_applied := true;
    end if;

    if v_projection_applied and p_action = 'unknown' then
      update public.word_progress
      set status = 'learning',
          due_at = v_effective_at,
          last_reviewed_at = v_effective_at,
          interval_days = 0,
          correct_streak = 0,
          lapses = v_progress.lapses + 1,
          reviewed_count = v_progress.reviewed_count + 1,
          unknown_count = v_progress.unknown_count + 1,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    elsif v_projection_applied then
      v_correct_streak := v_progress.correct_streak + 1;
      v_interval_days := v_progress.interval_days;
      v_next_status := v_progress.status;

      if v_progress.status = 'new' then
        v_next_status := 'learning';
        v_interval_days := 1;
      elsif v_progress.status = 'learning' then
        if v_correct_streak >= 2 then
          v_next_status := 'review';
          v_interval_days := 3;
        else
          v_interval_days := 1;
        end if;
      else
        v_next_status := case when v_progress.status = 'mastered' then 'mastered' else 'review' end;
        v_interval_days := least(greatest(v_progress.interval_days * 2, 3), 180);
      end if;

      if v_correct_streak >= 5 and v_interval_days >= 30 then
        v_next_status := 'mastered';
      end if;
      v_due_at := v_effective_at + make_interval(days => v_interval_days);

      update public.word_progress
      set status = v_next_status,
          due_at = v_due_at,
          last_reviewed_at = v_effective_at,
          interval_days = v_interval_days,
          correct_streak = v_correct_streak,
          reviewed_count = v_progress.reviewed_count + 1,
          known_count = v_progress.known_count + 1,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    end if;
  else
    select * into v_progress
    from public.word_progress p
    where p.user_id = p_user_id and p.word_entry_id = p_item_id;
  end if;

  if v_progress.id is not null then
    v_progress_json := jsonb_build_object(
      'status', v_progress.status,
      'due_at', v_progress.due_at,
      'reviewed_count', v_progress.reviewed_count,
      'known_count', v_progress.known_count,
      'unknown_count', v_progress.unknown_count
    );
  end if;

  -- Wrong-word rows are a projection of canonical observations. Unknown
  -- creates/reopens the projection; mastery archives it without deleting
  -- history or the link.
  if v_projection_applied and p_action = 'unknown' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'word-mistakes:' || p_user_id::text,
        0::bigint
      )
    );

    select l.problem_set_id, l.problem_id
      into v_problem_set_id, v_problem_id
      from public.word_mistake_links l
      where l.user_id = p_user_id and l.word_entry_id = p_item_id;

    if v_problem_id is not null then
      update public.problems
      set status = 'wrong',
          last_reviewed_date = v_effective_at,
          updated_at = now()
      where id = v_problem_id and user_id = p_user_id;
    else
      select s.id into v_subject_id
      from public.subjects s
      where s.user_id = p_user_id
        and s.name in ('英语', 'English', 'English Vocabulary')
      order by case s.name when '英语' then 0 when 'English' then 1 else 2 end
      limit 1;

      if v_subject_id is null then
        insert into public.subjects (user_id, name, color, icon)
        values (p_user_id, '英语', 'blue', 'BookOpen')
        returning id into v_subject_id;
      end if;

      select ps.id into v_problem_set_id
      from public.problem_sets ps
      where ps.user_id = p_user_id and ps.type = 'word_mistakes'
      limit 1;

      if v_problem_set_id is null then
        insert into public.problem_sets (
          user_id, subject_id, name, description, sharing_level,
          is_smart, allow_copying, is_listed, type
        ) values (
          p_user_id, v_subject_id, '遗忘的单词',
          '由单词学习记录自动维护。', 'private', false, false, false,
          'word_mistakes'
        ) returning id into v_problem_set_id;
      end if;

      insert into public.problems (
        user_id, subject_id, title, content, assets, auto_mark,
        solution_text, solution_assets, problem_type, status,
        correct_answer, last_reviewed_date, answer_config
      ) values (
        p_user_id,
        v_subject_id,
        v_entry.word,
        concat_ws(E'\n',
          'Word: ' || v_entry.word,
          case when v_entry.phonetic is not null then 'Phonetic: ' || v_entry.phonetic end,
          'Meaning: ' || v_entry.meaning,
          case when v_entry.example is not null then 'Example: ' || v_entry.example end,
          case when v_entry.example_translation is not null then 'Example translation: ' || v_entry.example_translation end
        ),
        '[]'::jsonb,
        false,
        v_entry.meaning,
        '[]'::jsonb,
        'short',
        'wrong',
        v_entry.word,
        v_effective_at,
        jsonb_build_object(
          'type', 'word_mistake',
          'word_entry_id', p_item_id,
          'normalized_word', v_entry.normalized_word
        )
      ) returning id into v_problem_id;

      insert into public.problem_set_problems (
        user_id, problem_set_id, problem_id
      ) values (p_user_id, v_problem_set_id, v_problem_id)
      on conflict (problem_set_id, problem_id) do nothing;

      insert into public.word_mistake_links (
        user_id, word_entry_id, problem_set_id, problem_id
      ) values (p_user_id, p_item_id, v_problem_set_id, v_problem_id);
    end if;
    v_wrong_problem_id := v_problem_id;
  elsif v_projection_applied and p_action = 'known'
        and v_progress.status = 'mastered' then
    update public.problems p
    set status = 'mastered',
        last_reviewed_date = v_effective_at,
        updated_at = now()
    from public.word_mistake_links l
    where l.user_id = p_user_id
      and l.word_entry_id = p_item_id
      and p.id = l.problem_id
      and p.user_id = p_user_id;
  end if;

  v_result := jsonb_build_object(
    'observation_id', v_observation_id,
    'session_id', p_session_id,
    'sequence', p_sequence,
    'item_id', p_item_id,
    'action', p_action,
    'progress', v_progress_json,
    'projection_applied', v_projection_applied,
    'replayed', false
  );

  insert into public.study_observations (
    id, user_id, device_id, request_id, session_id, sequence,
    item_id, action, mode, occurred_at, result
  ) values (
    v_observation_id, p_user_id, p_device_id, p_request_id, p_session_id,
    p_sequence, p_item_id, p_action, p_mode, p_occurred_at, v_result
  );

  -- Insert the canonical observation before its legacy projection because the
  -- latter has an immediate foreign key to study_observations.
  if p_action in ('known', 'unknown', 'skipped') then
    v_legacy_outcome := case when p_action = 'skipped' then 'skip' else p_action end;
    insert into public.word_review_events (
      user_id,
      word_entry_id,
      outcome,
      mode,
      source,
      device_id,
      wrong_problem_id,
      metadata,
      created_at,
      study_observation_id,
      request_id,
      session_id,
      sequence
    ) values (
      p_user_id,
      p_item_id,
      v_legacy_outcome,
      p_mode,
      case when p_device_id is null then 'web' else 'device' end,
      p_device_id,
      v_wrong_problem_id,
      '{}'::jsonb,
      v_effective_at,
      v_observation_id,
      p_request_id,
      p_session_id,
      p_sequence
    );
  end if;

  update public.study_sessions
  set next_sequence = next_sequence + 1,
      status = case when status = 'paused' then 'active' else status end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id;

  return v_result;
end;
$$;

revoke all on function public.record_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;

-- A terminally rejected observation cannot simply disappear from a monotonic
-- session: doing so would leave every later sequence in STUDY_SEQUENCE_GAP.
-- This endpoint advances the session with an explicit, non-projecting
-- tombstone. It deliberately does not require the item to be visible because
-- visibility/schema errors are one of the reasons the original observation
-- may have been rejected in the first place.
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
  v_result jsonb;
begin
  if p_user_id is null
     or p_request_id is null
     or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null
     or p_sequence is null
     or p_sequence < 0
     or p_sequence > 9007199254740991
     or p_item_id is null
     or p_action is null
     or p_action not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
     or p_mode is null
     or p_mode not in ('sequential', 'random', 'dictionary')
     or p_occurred_at is null then
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
       or v_existing.item_id <> p_item_id
       or v_existing.mode <> p_mode then
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
  if v_session.device_id is distinct from p_device_id
     or v_session.mode <> p_mode then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    raise exception using errcode = '40001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

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
    p_sequence, p_item_id, 'skipped', p_mode, p_occurred_at, v_result
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

create or replace function public.create_word_study_session_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_domain text,
  p_mode text,
  p_purpose text,
  p_ordering text,
  p_scope jsonb,
  p_optional_count integer,
  p_seed text,
  p_snapshot jsonb,
  p_candidate_items jsonb,
  p_progress_revision bigint,
  p_cursor text,
  p_has_more boolean,
  p_create_request_id text,
  p_create_fingerprint text
)
returns public.study_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.study_sessions%rowtype;
  v_created public.study_sessions%rowtype;
  v_pack jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'word-session:' || p_user_id::text || ':' ||
      coalesce(p_device_id::text, 'web') || ':' || coalesce(p_mode, ''),
      0::bigint
    )
  );

  select * into v_existing
  from public.study_sessions s
  where s.user_id = p_user_id
    and s.device_id is not distinct from p_device_id
    and s.create_request_id = p_create_request_id;

  if found then
    if v_existing.create_fingerprint <> p_create_fingerprint then
      raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
    end if;
    return v_existing;
  end if;

  if p_domain <> 'word' or jsonb_typeof(p_snapshot) <> 'array'
     or jsonb_typeof(p_candidate_items) <> 'array'
     or jsonb_array_length(p_candidate_items) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_SESSION';
  end if;

  -- Session creation and pack pruning take the same per-deck locks. A pack
  -- referenced by the new snapshot therefore cannot become stale mid-create.
  for v_pack in
    select value
    from jsonb_array_elements(p_snapshot)
    order by value ->> 'deck_id'
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'word-pack:' || (v_pack ->> 'deck_id'),
        0::bigint
      )
    );
    if not exists (
      select 1
      from public.word_packs p
      where p.deck_id = (v_pack ->> 'deck_id')::uuid
        and p.revision = (v_pack ->> 'pack_revision')::bigint
        and p.sha256 = v_pack ->> 'sha256'
        and p.status = 'ready'
    ) then
      raise exception using errcode = '40001', message = 'STUDY_PACK_CHANGED';
    end if;
  end loop;

  update public.study_sessions
  set status = 'abandoned',
      ended_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and device_id is not distinct from p_device_id
    and mode = p_mode
    and status in ('active', 'paused');

  insert into public.study_sessions (
    user_id, device_id, domain, mode, purpose, ordering, scope,
    optional_count, seed, snapshot, candidate_items, candidate_count,
    progress_revision, cursor, has_more, next_sequence, status,
    create_request_id, create_fingerprint
  ) values (
    p_user_id, p_device_id, p_domain, p_mode, p_purpose, p_ordering, p_scope,
    p_optional_count, p_seed, p_snapshot, p_candidate_items,
    jsonb_array_length(p_candidate_items), p_progress_revision, p_cursor,
    p_has_more, 0, 'active', p_create_request_id, p_create_fingerprint
  ) returning * into v_created;

  return v_created;
end;
$$;

revoke all on function public.create_word_study_session_v1(
  uuid, uuid, text, text, text, text, jsonb, integer, text, jsonb, jsonb,
  bigint, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.create_word_study_session_v1(
  uuid, uuid, text, text, text, text, jsonb, integer, text, jsonb, jsonb,
  bigint, text, boolean, text, text
) to service_role;

create or replace function public.prune_word_packs_v1(p_deck_id uuid)
returns table (id uuid, storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'word-pack:' || p_deck_id::text,
      0::bigint
    )
  );

  return query
  with ranked as (
    select p.id, p.storage_path, p.revision,
           row_number() over (order by p.revision desc, p.updated_at desc) as rank
    from public.word_packs p
    where p.deck_id = p_deck_id
      and p.schema_version = 2
      and p.status = 'ready'
  ), stale as (
    select r.id, r.storage_path
    from ranked r
    where r.rank > 2
      and not exists (
        select 1
        from public.study_sessions s
        cross join lateral jsonb_array_elements(s.snapshot) as pinned(value)
        where s.status in ('active', 'paused')
          and s.expires_at > now()
          and pinned.value ->> 'deck_id' = p_deck_id::text
          and (pinned.value ->> 'pack_revision')::bigint = r.revision
      )
  ), updated as (
    update public.word_packs p
    set status = 'stale', updated_at = now()
    from stale
    where p.id = stale.id
    returning p.id, p.storage_path
  )
  select updated.id, updated.storage_path from updated;
end;
$$;

revoke all on function public.prune_word_packs_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.prune_word_packs_v1(uuid) to service_role;
