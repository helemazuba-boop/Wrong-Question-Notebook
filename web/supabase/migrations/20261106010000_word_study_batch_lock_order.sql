-- Keep single and batch canonical study writes in the same lock order.
-- The original batch locked a session before its first request lock, and
-- acquired progress rows progressively. Real single/batch and reversed-item
-- schedules could deadlock. Preserve the original observation semantics,
-- exact-prefix receipts and rollback rules; only add canonical admission gates.
-- Both functions retain service-role-only execution and a 2 s lock budget.

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
set lock_timeout = '2s'
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
  v_authority_mode text;
begin
  if p_user_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null or p_item_id is null
     or p_sequence < 0 or p_sequence > 9007199254740991
     or p_action not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
     or p_mode not in ('sequential', 'random', 'dictionary', 'review', 'intake', 'shuffle', 'mistakes')
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
    -- A retired session can never receive the missing lower sequence: the
    -- replacement session already owns the device, and the outbox is FIFO, so
    -- nothing earlier is still in flight. Answering STUDY_SEQUENCE_GAP here
    -- would make the device retry this record forever and wedge the whole
    -- queue; closing the session lets it quarantine and drain instead.
    if v_session.status = 'abandoned' then
      raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
    end if;
    -- A missing earlier observation is recoverable: the device must keep this
    -- head pending until the lower sequence arrives.
    raise exception using errcode = 'P0001', message = 'STUDY_SEQUENCE_GAP';
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

  select settings.authority_mode into v_authority_mode
  from public.user_word_scheduler_settings settings
  where settings.user_id = p_user_id;
  v_authority_mode := coalesce(v_authority_mode, 'sm2');

  -- A batch takes all item gates before touching any progress/projection
  -- rows. Singles take the same one gate after their session row, preserving
  -- request -> session -> item -> progress/projection lock order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'word-study-item:' || p_user_id::text || ':' || p_item_id::text,
      0::bigint
    )
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

    if v_projection_applied and p_action = 'unknown' and v_authority_mode = 'sm2' then
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
    elsif v_projection_applied and p_action = 'known' and v_authority_mode = 'sm2' then
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
    elsif v_projection_applied then
      -- FSRS authority: the counters stay synchronous so the word lists keep
      -- showing live numbers, while status/due_at/interval_days/lapses are
      -- written by the projector from the FSRS card.
      update public.word_progress
      set last_reviewed_at = v_effective_at,
          reviewed_count = v_progress.reviewed_count + 1,
          known_count = v_progress.known_count
            + case when p_action = 'known' then 1 else 0 end,
          unknown_count = v_progress.unknown_count
            + case when p_action = 'unknown' then 1 else 0 end,
          updated_at = now()
      where id = v_progress.id
      returning * into v_progress;
    end if;

    -- The shadow tracks every fact in both modes: it has to be current before
    -- a cutover can promote it, and a stale event still changes the timeline
    -- fingerprint the projector validates against.
    perform private.mark_word_progress_timeline_dirty(
      p_user_id,
      p_item_id,
      v_effective_at
    );
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
        'word-mistakes:' || p_user_id::text || ':' || p_item_id::text,
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
        user_id, subject_id, title, content, assets,
        solution_text, solution_assets, parts, status,
        last_reviewed_date
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
        v_entry.meaning,
        '[]'::jsonb,
        jsonb_build_array(
          jsonb_build_object(
            'index', 1,
            'type', 'short_answer',
            'correct_answer', v_entry.word,
            'answer_config', jsonb_build_object(
              'type', 'word_mistake',
              'word_entry_id', p_item_id,
              'normalized_word', v_entry.normalized_word
            )
          )
        ),
        'wrong',
        v_effective_at
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
    -- Optional on purpose: an idempotent replay returns the result JSON that
    -- was persisted when the observation first landed, which predates this
    -- field. Callers must treat a missing value as 'sm2'.
    'authority_mode', v_authority_mode,
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

create or replace function public.record_word_study_observation_batch_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_observations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_session public.study_sessions%rowtype;
  v_observation jsonb;
  v_existing public.study_observations%rowtype;
  v_result jsonb;
  v_accepted jsonb := '[]'::jsonb;
  v_failure jsonb := null;
  v_count integer;
  v_index integer := 0;
  v_sequence bigint;
  v_expected_sequence bigint;
  v_error_code text;
  v_retryable boolean;
  v_sqlstate text;
  v_request_lock bigint;
  v_item_lock bigint;
begin
  if p_user_id is null or p_device_id is null or p_session_id is null
     or jsonb_typeof(p_observations) <> 'array'
     or jsonb_array_length(p_observations) < 1
     or jsonb_array_length(p_observations) > 64 then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;
  if not exists (
    select 1 from public.esp32_devices d
    where d.id = p_device_id and d.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'WORD_LOCAL_DEVICE_NOT_OWNED';
  end if;

  -- Strict array shape: malformed observations cannot become a receipt.
  if exists (
    select 1
    from jsonb_array_elements(p_observations) with ordinality as t(value, position)
    where jsonb_typeof(t.value) <> 'object'
       or coalesce(jsonb_typeof(t.value -> 'request_id'), '') <> 'string'
       or (t.value ->> 'request_id') !~ '^[A-Za-z0-9_-]{16,64}$'
       or coalesce(jsonb_typeof(t.value -> 'sequence'), '') <> 'number'
       or (t.value ->> 'sequence')::numeric <> trunc((t.value ->> 'sequence')::numeric)
       or (t.value ->> 'sequence')::numeric < 0
       or (t.value ->> 'sequence')::numeric > 9007199254740991
       or coalesce(jsonb_typeof(t.value -> 'item_id'), '') <> 'string'
       or (t.value ->> 'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(t.value -> 'action'), '') <> 'string'
       or (t.value ->> 'action') not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
       or coalesce(jsonb_typeof(t.value -> 'mode'), '') <> 'string'
       or (t.value ->> 'mode') not in ('sequential', 'random', 'dictionary', 'review', 'intake', 'shuffle', 'mistakes')
       or coalesce(jsonb_typeof(t.value -> 'occurred_at'), '') <> 'string'
       or (t.value ->> 'occurred_at') !~ '^\d{4}-\d{2}-\d{2}T'
       or (position > 1
           and (t.value ->> 'sequence')::bigint <>
               ((p_observations -> ((position - 2)::integer) ->> 'sequence')::bigint + 1))
  ) then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;
  select count(distinct value ->> 'request_id') into v_count
  from jsonb_array_elements(p_observations);
  if v_count <> jsonb_array_length(p_observations) then
    raise exception using errcode = '23505', message = 'STUDY_REQUEST_ID_REUSED';
  end if;

  -- Acquire EVERY request lock before the session row, matching singles.
  -- Sort the actual bigint lock keys (including hash collisions), not input
  -- sequence order: batches may overlap in a different request order.
  for v_request_lock in
    select distinct pg_catalog.hashtextextended(
      p_user_id::text || ':' || coalesce(p_device_id::text, 'web') || ':' || (value ->> 'request_id'),
      0::bigint
    ) as lock_key
    from jsonb_array_elements(p_observations)
    order by lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(v_request_lock);
  end loop;

  -- Preserve compatibility with every word mode and with expired sessions:
  -- ownership/device/domain are the only batch-level session predicates.
  -- The original record RPC owns status/expiry/mode/membership/sequence checks,
  -- including its replay path before session-validity checks.
  select * into v_session from public.study_sessions s
  where s.id = p_session_id and s.user_id = p_user_id
    and s.device_id is not distinct from p_device_id
    and s.domain = 'word'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;

  -- Different sessions can judge the same words in opposite orders. Take
  -- all per-user/item gates in one canonical order before any RPC mutates
  -- progress/projections. No speculative progress rows or facts are created.
  for v_item_lock in
    select distinct pg_catalog.hashtextextended(
      'word-study-item:' || p_user_id::text || ':' || ((value ->> 'item_id')::uuid)::text,
      0::bigint
    ) as lock_key
    from jsonb_array_elements(p_observations)
    order by lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(v_item_lock);
  end loop;

  for v_observation in select value from jsonb_array_elements(p_observations) loop
    v_sequence := (v_observation ->> 'sequence')::bigint;
    if v_index > 0 then
      v_expected_sequence :=
        (p_observations -> (v_index - 1) ->> 'sequence')::bigint + 1;
      if v_sequence <> v_expected_sequence then
        raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_GAP';
      end if;
    end if;
    -- Explicit replay check does not consult session status/expiry. A lost
    -- acknowledgement for an already durable fact is ACKed even after expiry;
    -- a new request on an expired session goes through the original RPC.
    select * into v_existing
    from public.study_observations o
    where o.user_id = p_user_id
      and o.device_id is not distinct from p_device_id
      and o.request_id = v_observation ->> 'request_id';
    if found then
      if v_existing.session_id <> p_session_id
         or v_existing.sequence <> v_sequence
         or v_existing.item_id <> (v_observation ->> 'item_id')::uuid
         or v_existing.action <> v_observation ->> 'action'
         or v_existing.mode <> v_observation ->> 'mode'
         or v_existing.occurred_at <> (v_observation ->> 'occurred_at')::timestamptz then
        v_failure := jsonb_build_object(
          'request_id', v_observation ->> 'request_id',
          'sequence', v_sequence,
          'code', 'REQUEST_ID_REUSED',
          'retryable', false
        );
        exit;
      end if;
    end if;

    begin
      -- The original RPC remains the only projection writer. Its candidate
      -- membership, actor, sequence and request-id checks are not duplicated
      -- or bypassed here.
      v_result := public.record_study_observation_v1(
        p_user_id,
        p_device_id,
        v_observation ->> 'request_id',
        p_session_id,
        v_sequence,
        (v_observation ->> 'item_id')::uuid,
        v_observation ->> 'action',
        v_observation ->> 'mode',
        (v_observation ->> 'occurred_at')::timestamptz
      );
      v_accepted := v_accepted || jsonb_build_array(jsonb_build_object(
        'request_id', v_observation ->> 'request_id',
        'observation_id', v_result ->> 'observation_id',
        'sequence', (v_result ->> 'sequence')::bigint,
        'replayed', coalesce((v_result ->> 'replayed')::boolean, false)
      ));
    exception
      when others then
        get stacked diagnostics v_sqlstate = returned_sqlstate;
        -- Only exact known semantic (SQLSTATE, message) pairs are terminal
        -- prefix failures. Every unknown DB error re-raises and rolls back
        -- the whole batch, including the already accepted prefix.
        v_error_code := case
          when v_sqlstate in ('22023', '23505')
               and sqlerrm = 'STUDY_REQUEST_ID_REUSED' then 'REQUEST_ID_REUSED'
          when v_sqlstate in ('22023', 'P0001')
               and sqlerrm = 'STUDY_SEQUENCE_GAP' then 'SEQUENCE_GAP'
          when v_sqlstate = '22023'
               and sqlerrm = 'STUDY_SEQUENCE_ALREADY_APPLIED' then 'SEQUENCE_ALREADY_APPLIED'
          when v_sqlstate = '22023'
               and sqlerrm = 'STUDY_SESSION_NOT_ACTIVE' then 'SESSION_NOT_ACTIVE'
          when v_sqlstate = '22023'
               and sqlerrm = 'STUDY_ITEM_NOT_VISIBLE' then 'ITEM_NOT_VISIBLE'
          when v_sqlstate = '22023'
               and sqlerrm = 'STUDY_ITEM_NOT_IN_SESSION' then 'ITEM_NOT_IN_SESSION'
          when v_sqlstate = '22023'
               and sqlerrm = 'STUDY_SESSION_ACTOR_MISMATCH' then 'SESSION_ACTOR_MISMATCH'
          when v_sqlstate = '22023'
               and sqlerrm = 'INVALID_STUDY_OBSERVATION' then 'INVALID_OBSERVATION'
          else null
        end;
        if v_error_code is null then
          raise;
        end if;
        v_retryable := v_error_code = 'SEQUENCE_GAP';
        v_failure := jsonb_build_object(
          'request_id', v_observation ->> 'request_id',
          'sequence', v_sequence,
          'code', v_error_code,
          'retryable', v_retryable
        );
        exit;
    end;
    v_index := v_index + 1;
  end loop;

  if jsonb_array_length(v_accepted) = jsonb_array_length(p_observations) then
    v_failure := null;
  elsif v_failure is null then
    raise exception using errcode = 'P0001', message = 'WORD_BATCH_RECEIPT_INCOMPLETE';
  end if;

  return jsonb_build_object(
    'session_id', p_session_id,
    'accepted', v_accepted,
    'failure', v_failure
  );
end;
$$;

revoke all on function public.record_word_study_observation_batch_v1(
  uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_word_study_observation_batch_v1(
  uuid, uuid, uuid, jsonb
) to service_role;
