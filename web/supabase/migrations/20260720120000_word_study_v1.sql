-- Word Study v1: reusable study sessions, append-only observations, atomic
-- progress projection, and a monotonic per-domain change feed.
--
-- This migration is additive. Legacy word review routes remain available until
-- the firmware UI/outbox switches in W4, but new v1 observations are canonical.

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.esp32_devices(id) on delete set null,
  domain text not null,
  mode text not null,
  purpose text not null,
  ordering text not null,
  scope jsonb not null,
  optional_count integer,
  seed text not null,
  snapshot jsonb not null default '[]'::jsonb,
  candidate_ids uuid[] not null default '{}',
  candidate_items jsonb not null default '[]'::jsonb,
  cursor text,
  has_more boolean not null default false,
  next_sequence bigint not null default 0,
  status text not null default 'active',
  create_request_id text not null,
  create_fingerprint text not null,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_sessions_domain_v1_check check (domain = 'word'),
  constraint study_sessions_mode_v1_check check (mode in ('sequential', 'random', 'dictionary')),
  constraint study_sessions_purpose_v1_check check (purpose in ('study', 'lookup')),
  constraint study_sessions_ordering_v1_check check (ordering in ('sequential', 'guided_random_v1', 'lexicographic')),
  constraint study_sessions_semantics_v1_check check (
    (mode = 'sequential' and purpose = 'study' and ordering = 'sequential')
    or (mode = 'random' and purpose = 'study' and ordering = 'guided_random_v1')
    or (mode = 'dictionary' and purpose = 'lookup' and ordering = 'lexicographic')
  ),
  constraint study_sessions_scope_v1_check check (
    jsonb_typeof(scope) = 'object'
    and jsonb_typeof(scope -> 'deck_ids') = 'array'
    and jsonb_typeof(scope -> 'include_mastered') = 'boolean'
    and jsonb_array_length(scope -> 'deck_ids') <= 32
  ),
  constraint study_sessions_optional_count_v1_check check (optional_count is null or optional_count between 1 and 500),
  constraint study_sessions_seed_v1_check check (seed ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint study_sessions_snapshot_v1_check check (jsonb_typeof(snapshot) = 'array' and jsonb_array_length(snapshot) <= 32),
  constraint study_sessions_candidates_v1_check check (cardinality(candidate_ids) <= 500),
  constraint study_sessions_candidate_items_v1_check check (
    jsonb_typeof(candidate_items) = 'array'
    and jsonb_array_length(candidate_items) <= 500
  ),
  constraint study_sessions_cursor_v1_check check (cursor is null or char_length(cursor) <= 256),
  constraint study_sessions_next_sequence_v1_check check (next_sequence between 0 and 9007199254740991),
  constraint study_sessions_status_v1_check check (status in ('active', 'paused', 'completed', 'abandoned')),
  constraint study_sessions_create_request_v1_check check (create_request_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  constraint study_sessions_create_fingerprint_v1_check check (create_fingerprint ~ '^[0-9a-f]{64}$')
);

create table if not exists public.study_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.esp32_devices(id) on delete set null,
  request_id text not null,
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  sequence bigint not null,
  item_id uuid not null,
  action text not null,
  mode text not null,
  occurred_at timestamptz not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint study_observations_request_v1_check check (request_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  constraint study_observations_sequence_v1_check check (sequence between 0 and 9007199254740991),
  constraint study_observations_action_v1_check check (action in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')),
  constraint study_observations_mode_v1_check check (mode in ('sequential', 'random', 'dictionary')),
  constraint study_observations_result_v1_check check (jsonb_typeof(result) = 'object'),
  unique (session_id, sequence)
);

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
begin
  if p_user_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null or p_item_id is null
     or p_sequence < 0 or p_sequence > 9007199254740991
     or p_action not in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up')
     or p_mode not in ('sequential', 'random', 'dictionary')
     or p_occurred_at is null or p_occurred_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_OBSERVATION';
  end if;

  -- Serialize identical request IDs before touching session or progress state.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      p_user_id::text || ':' || coalesce(p_device_id::text, 'web') || ':' || p_request_id
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
  for update;

  if not found or v_session.domain <> 'word' or v_session.status not in ('active', 'paused') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id or v_session.mode <> p_mode then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if v_session.next_sequence <> p_sequence then
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_OUT_OF_ORDER';
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
  if not (p_item_id = any(v_session.candidate_ids)) then
    raise exception using errcode = '22023', message = 'STUDY_ITEM_NOT_IN_SESSION';
  end if;

  v_effective_at := greatest(p_occurred_at, timestamptz '2000-01-01 00:00:00+00');

  if p_action in ('known', 'unknown') then
    insert into public.word_progress (user_id, word_entry_id)
    values (p_user_id, p_item_id)
    on conflict (user_id, word_entry_id) do nothing;

    select * into v_progress
    from public.word_progress p
    where p.user_id = p_user_id and p.word_entry_id = p_item_id
    for update;

    if p_action = 'unknown' then
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
    else
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
  if p_action = 'unknown' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('word-mistakes:' || p_user_id::text)
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
  elsif p_action = 'known' and v_progress.status = 'mastered' then
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
