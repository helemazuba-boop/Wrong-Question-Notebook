-- Problem Gaokao shell model (V1).
--
-- The upstream problem model was built for the Australian HSC: a single
-- problem_type ('mcq'/'short'/'extended') with one answer per problem. Gaokao
-- problems do not fit that shape -- a single 大题 routinely nests a choice, a
-- few blanks and a written part, each with its own marks. This migration
-- switches to the shell model: every problem is a shell (photo/source/status/
-- review scheduling) holding 1..10 inner parts, each with its own type, label,
-- marks and answer configuration. Nesting is capped at exactly one level.
--
-- Hard cutover by agreement: existing rows are wrapped into single-part
-- shells and the legacy columns are dropped in the same migration (paired
-- deploy with the web release; no compatibility window).

-- =====================================================
-- 1. Part type enum (source of truth for allowed types)
-- =====================================================
create type public.problem_part_type as enum (
  'single_choice',  -- 单选
  'multi_choice',   -- 多选（漏选得部分分）
  'fill_blank',     -- 填空（多空 = 多个 part）
  'short_answer',   -- 简答
  'essay'           -- 论述/作文
);

-- =====================================================
-- 2. New columns
-- =====================================================
alter table public.problems
  add column parts jsonb not null default '[]'::jsonb,
  -- Exam provenance: { year, paper, exam_type, question_no } -- loose on
  -- purpose, promoted to columns only if querying patterns demand it.
  add column source jsonb not null default '{}'::jsonb,
  -- 选做题 (choose-one-of-N exam sections) is a shell-level attribute, not a
  -- part type.
  add column is_optional boolean not null default false;

alter table public.attempts
  -- Per-part outcome: [{ index, correct, score? }]. is_correct stays as the
  -- all-parts-correct rollup so existing stats keep working.
  add column part_results jsonb not null default '[]'::jsonb,
  add constraint attempts_part_results_array
    check (jsonb_typeof(part_results) = 'array');

alter table public.error_categorisations
  -- Which inner part the categorisation points at; null = not located to a
  -- part (all historical rows).
  add column part_index smallint;

-- =====================================================
-- 3. Backfill: wrap every legacy row into a single-part shell
-- =====================================================
-- Legacy type mapping: mcq -> single_choice, short -> short_answer,
-- extended -> essay. Auto-markability is no longer a flag: a part with an
-- answer_config (or legacy correct_answer) is auto-markable, so behaviour is
-- preserved without carrying auto_mark over. jsonb_strip_nulls drops the
-- answer keys for rows that never had them.
update public.problems
set parts = jsonb_build_array(
  jsonb_strip_nulls(
    jsonb_build_object(
      'index', 1,
      'type', case problem_type::text
        when 'mcq' then 'single_choice'
        when 'short' then 'short_answer'
        else 'essay'
      end,
      'correct_answer', correct_answer,
      'answer_config', answer_config
    )
  )
);

-- Smart problem sets persist part-type filters inside filter_config;
-- translate the legacy values so existing sets keep matching.
update public.problem_sets
set filter_config = jsonb_set(
  filter_config,
  '{problem_types}',
  coalesce(
    (
      select jsonb_agg(
        case value
          when 'mcq' then 'single_choice'
          when 'short' then 'short_answer'
          when 'extended' then 'essay'
          else value
        end
      )
      from jsonb_array_elements_text(filter_config -> 'problem_types')
    ),
    '[]'::jsonb
  )
)
where filter_config ? 'problem_types'
  and jsonb_array_length(coalesce(filter_config -> 'problem_types', '[]'::jsonb)) > 0;

-- =====================================================
-- 4. Shell shape validation
-- =====================================================
-- zod owns the detailed shape; this guard enforces the structural invariants
-- that must never be violated at rest: an array of 1..10 objects, contiguous
-- 1-based indexes, and a known part type (cast against the enum).
create or replace function public.problem_parts_valid(p jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  n integer;
  i integer;
  part jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  n := jsonb_array_length(p);
  if n < 1 or n > 10 then
    return false;
  end if;
  for i in 0..n - 1 loop
    part := p -> i;
    if jsonb_typeof(part) <> 'object' then
      return false;
    end if;
    if (part ->> 'index')::integer is distinct from i + 1 then
      return false;
    end if;
    perform (part ->> 'type')::public.problem_part_type;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.problems
  add constraint problems_parts_shell check (public.problem_parts_valid(parts));

-- Every insert must now provide an explicit shell; the temporary '[]' default
-- would violate the constraint anyway.
alter table public.problems alter column parts drop default;

-- Containment lookups ("any part of this type"): parts @> '[{"type": ...}]'.
create index idx_problems_parts on public.problems
  using gin (parts jsonb_path_ops);

-- =====================================================
-- 5. Smart-set filters: problem_types now match ANY part's type
-- =====================================================
CREATE OR REPLACE FUNCTION public.compute_problem_set_count(p_problem_set_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_ps record;
  v_count integer;
BEGIN
  SELECT * INTO v_ps FROM problem_sets WHERE id = p_problem_set_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF v_ps.is_smart THEN
    SELECT COUNT(*)::integer INTO v_count
    FROM problems p
    WHERE p.user_id = v_ps.user_id
      AND p.subject_id = v_ps.subject_id
      AND (
        jsonb_array_length(COALESCE(v_ps.filter_config->'statuses', '[]'::jsonb)) = 0
        OR p.status::text IN (SELECT jsonb_array_elements_text(v_ps.filter_config->'statuses'))
      )
      -- Part type filter: a shell matches when ANY of its parts has a
      -- requested type (filter values are part types since the shell model).
      AND (
        jsonb_array_length(COALESCE(v_ps.filter_config->'problem_types', '[]'::jsonb)) = 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.parts) part
          WHERE part->>'type' IN (SELECT jsonb_array_elements_text(v_ps.filter_config->'problem_types'))
        )
      )
      AND (
        jsonb_array_length(COALESCE(v_ps.filter_config->'tag_ids', '[]'::jsonb)) = 0
        OR EXISTS (
          SELECT 1 FROM problem_tag pt
          WHERE pt.problem_id = p.id
            AND pt.tag_id::text IN (SELECT jsonb_array_elements_text(v_ps.filter_config->'tag_ids'))
        )
      )
      AND (
        (v_ps.filter_config->>'days_since_review') IS NULL
        OR p.last_reviewed_date < now() - ((v_ps.filter_config->>'days_since_review')::int * interval '1 day')
        OR (p.last_reviewed_date IS NULL AND COALESCE((v_ps.filter_config->>'include_never_reviewed')::boolean, true))
      );
  ELSE
    SELECT COUNT(*)::integer INTO v_count
    FROM problem_set_problems
    WHERE problem_set_id = p_problem_set_id;
  END IF;

  RETURN v_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_ranking_scores()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Update problem_count for manual sets (from junction table)
  UPDATE problem_set_stats s
  SET problem_count = COALESCE(sub.cnt, 0)
  FROM problem_sets ps
  LEFT JOIN (
    SELECT problem_set_id, COUNT(*)::integer AS cnt
    FROM problem_set_problems
    GROUP BY problem_set_id
  ) sub ON sub.problem_set_id = ps.id
  WHERE s.problem_set_id = ps.id
    AND ps.is_smart = false
    AND ps.sharing_level = 'public';

  -- Update problem_count for smart sets (accurate filter_config evaluation)
  UPDATE problem_set_stats s
  SET problem_count = (
    SELECT COUNT(*)::integer
    FROM problems p
    WHERE p.user_id = ps.user_id
      AND p.subject_id = ps.subject_id
      -- Status filter: empty array = no filter
      AND (
        jsonb_array_length(COALESCE(ps.filter_config->'statuses', '[]'::jsonb)) = 0
        OR p.status::text IN (
          SELECT jsonb_array_elements_text(ps.filter_config->'statuses')
        )
      )
      -- Part type filter: empty array = no filter; shell matches on ANY part
      AND (
        jsonb_array_length(COALESCE(ps.filter_config->'problem_types', '[]'::jsonb)) = 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.parts) part
          WHERE part->>'type' IN (
            SELECT jsonb_array_elements_text(ps.filter_config->'problem_types')
          )
        )
      )
      -- Tag filter: empty array = no filter
      AND (
        jsonb_array_length(COALESCE(ps.filter_config->'tag_ids', '[]'::jsonb)) = 0
        OR EXISTS (
          SELECT 1 FROM problem_tag pt
          WHERE pt.problem_id = p.id
            AND pt.tag_id::text IN (
              SELECT jsonb_array_elements_text(ps.filter_config->'tag_ids')
            )
        )
      )
      -- Days since review filter
      AND (
        (ps.filter_config->>'days_since_review') IS NULL
        OR (
          p.last_reviewed_date < now() - ((ps.filter_config->>'days_since_review')::int * interval '1 day')
        )
        OR (
          p.last_reviewed_date IS NULL
          AND COALESCE((ps.filter_config->>'include_never_reviewed')::boolean, true)
        )
      )
  )
  FROM problem_sets ps
  WHERE s.problem_set_id = ps.id
    AND ps.is_smart = true
    AND ps.sharing_level = 'public';

  -- Update ranking scores
  UPDATE problem_set_stats s
  SET ranking_score = (
    (s.like_count * 3) + (s.copy_count * 5) + (s.unique_view_count * 0.5)
  ) * (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - ps.created_at)) / 2592000.0)),
  updated_at = now()
  FROM problem_sets ps
  WHERE s.problem_set_id = ps.id
    AND ps.sharing_level = 'public'
    AND ps.is_listed = true;
END;
$function$
;

-- =====================================================
-- 6. get_uncategorised_attempts: expose the shell instead of legacy columns
-- =====================================================
-- The OUT row type changes, so the old signature must be dropped first.
DROP FUNCTION public.get_uncategorised_attempts(uuid, integer);

CREATE OR REPLACE FUNCTION public.get_uncategorised_attempts(p_user_id uuid, p_limit integer)
 RETURNS TABLE(attempt_id uuid, problem_id uuid, subject_id uuid, submitted_answer jsonb, part_results jsonb, is_correct boolean, cause text, reflection_notes text, selected_status text, attempt_created_at timestamp with time zone, problem_title text, problem_content text, problem_parts jsonb, subject_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    a.id AS attempt_id,
    a.problem_id,
    p.subject_id,
    to_jsonb(a.submitted_answer) AS submitted_answer,
    a.part_results,
    a.is_correct,
    a.cause,
    a.reflection_notes,
    a.selected_status::text,
    a.created_at AS attempt_created_at,
    p.title AS problem_title,
    p.content AS problem_content,
    p.parts AS problem_parts,
    s.name AS subject_name
  FROM attempts a
  JOIN problems p ON p.id = a.problem_id AND p.user_id = p_user_id
  JOIN subjects s ON s.id = p.subject_id AND s.user_id = p_user_id
  LEFT JOIN error_categorisations ec ON ec.attempt_id = a.id
  WHERE a.user_id = p_user_id
    AND ec.id IS NULL
    AND a.selected_status IN ('wrong', 'needs_review')
  ORDER BY a.created_at DESC
  LIMIT p_limit;
END;
$function$
;

-- =====================================================
-- 7. record_study_observation_v1: word-mistake projection writes a shell
-- =====================================================
-- Full re-emit of the 20260723000000 version; the only change is the INSERT
-- INTO public.problems, which now writes a single short_answer part (the
-- word as its exact answer, the word_mistake projection metadata riding in
-- the part's answer_config exactly as it used to ride the column).
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

-- =====================================================
-- 8. Retire the legacy columns and enum
-- =====================================================
-- Dependent indexes (idx_problems_answer_config, problems_correct_answer_idx)
-- and check constraints drop with their columns.
alter table public.problems
  drop column problem_type,
  drop column correct_answer,
  drop column answer_config,
  drop column auto_mark;

drop type public.problem_type_enum;
