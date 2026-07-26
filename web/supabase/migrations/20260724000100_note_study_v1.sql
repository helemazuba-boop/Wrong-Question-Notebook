-- Note Study v1: extend the shared study runtime to the note domain.
--
-- Reuses public.study_sessions / public.study_observations (domain = 'note')
-- rather than forking new tables. The word-only v1 CHECK constraints are
-- replaced with domain-partitioned v2 constraints that preserve the word branch
-- verbatim and add the note branch. Adds note_read_state (read projection, no
-- mastery) and the note session/observation/skip RPCs. Additive + idempotent.

-- 1. Domain-partitioned constraints -----------------------------------------
alter table public.study_sessions drop constraint if exists study_sessions_domain_v1_check;
alter table public.study_sessions drop constraint if exists study_sessions_mode_v1_check;
alter table public.study_sessions drop constraint if exists study_sessions_purpose_v1_check;
alter table public.study_sessions drop constraint if exists study_sessions_ordering_v1_check;
alter table public.study_sessions drop constraint if exists study_sessions_semantics_v1_check;
alter table public.study_sessions drop constraint if exists study_sessions_scope_v1_check;

alter table public.study_sessions drop constraint if exists study_sessions_domain_v2_check;
alter table public.study_sessions add constraint study_sessions_domain_v2_check
  check (domain in ('word', 'note'));

alter table public.study_sessions drop constraint if exists study_sessions_mode_v2_check;
alter table public.study_sessions add constraint study_sessions_mode_v2_check
  check (mode in ('sequential', 'random', 'dictionary', 'recent'));

alter table public.study_sessions drop constraint if exists study_sessions_purpose_v2_check;
alter table public.study_sessions add constraint study_sessions_purpose_v2_check
  check (purpose in ('study', 'lookup', 'browse'));

alter table public.study_sessions drop constraint if exists study_sessions_ordering_v2_check;
alter table public.study_sessions add constraint study_sessions_ordering_v2_check
  check (ordering in ('sequential', 'guided_random_v1', 'lexicographic', 'sequential_note_v1', 'least_recently_viewed_v1'));

alter table public.study_sessions drop constraint if exists study_sessions_semantics_v2_check;
alter table public.study_sessions add constraint study_sessions_semantics_v2_check check (
  (domain = 'word' and (
    (mode = 'sequential' and purpose = 'study' and ordering = 'sequential')
    or (mode = 'random' and purpose = 'study' and ordering = 'guided_random_v1')
    or (mode = 'dictionary' and purpose = 'lookup' and ordering = 'lexicographic')
  ))
  or (domain = 'note' and (
    (mode = 'sequential' and purpose = 'browse' and ordering = 'sequential_note_v1')
    or (mode = 'recent' and purpose = 'browse' and ordering = 'least_recently_viewed_v1')
  ))
);

alter table public.study_sessions drop constraint if exists study_sessions_scope_v2_check;
alter table public.study_sessions add constraint study_sessions_scope_v2_check check (
  jsonb_typeof(scope) = 'object'
  and (
    (domain = 'word'
      and jsonb_typeof(scope -> 'deck_ids') = 'array'
      and jsonb_typeof(scope -> 'include_mastered') = 'boolean'
      and jsonb_array_length(scope -> 'deck_ids') <= 32)
    or (domain = 'note'
      and jsonb_typeof(scope -> 'notebook_ids') = 'array'
      and jsonb_typeof(scope -> 'include_archived') = 'boolean'
      and jsonb_array_length(scope -> 'notebook_ids') <= 32)
  )
);

alter table public.study_observations drop constraint if exists study_observations_action_v1_check;
alter table public.study_observations drop constraint if exists study_observations_mode_v1_check;

alter table public.study_observations drop constraint if exists study_observations_action_v2_check;
alter table public.study_observations add constraint study_observations_action_v2_check
  check (action in ('shown', 'revealed', 'known', 'unknown', 'skipped', 'looked_up', 'opened', 'read_completed', 'session_paused'));

alter table public.study_observations drop constraint if exists study_observations_mode_v2_check;
alter table public.study_observations add constraint study_observations_mode_v2_check
  check (mode in ('sequential', 'random', 'dictionary', 'recent'));

-- 2. Read-state projection ---------------------------------------------------
-- The note domain projects reads only: never mastery / schedule.
create table if not exists public.note_read_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notebook_notes(id) on delete cascade,
  last_opened_at timestamptz,
  last_completed_at timestamptz,
  completed_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, note_id),
  constraint note_read_state_completed_count_check
    check (completed_count between 0 and 9007199254740991)
);

alter table public.note_read_state enable row level security;
revoke all on table public.note_read_state from anon, authenticated;
grant select on table public.note_read_state to authenticated;
grant all on table public.note_read_state to service_role;

drop policy if exists note_read_state_owner_select on public.note_read_state;
create policy note_read_state_owner_select on public.note_read_state
for select to authenticated
using ((select auth.uid()) = user_id);

-- 3. create_note_study_session_v1 -------------------------------------------
create or replace function public.create_note_study_session_v1(
  p_user_id uuid,
  p_device_id uuid,
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
      'note-session:' || p_user_id::text || ':' ||
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

  if jsonb_typeof(p_snapshot) <> 'array'
     or jsonb_typeof(p_candidate_items) <> 'array'
     or jsonb_array_length(p_candidate_items) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_SESSION';
  end if;

  -- Pin notebook scope: each snapshot notebook must still be visible (owned,
  -- not archived). Per-notebook content revision derives from note_change_log,
  -- not notebooks.revision, so it is carried in the snapshot rather than
  -- re-validated here; a vanished/archived notebook invalidates the session.
  for v_pack in
    select value
    from jsonb_array_elements(p_snapshot)
    order by value ->> 'notebook_id'
  loop
    if not exists (
      select 1
      from public.notebooks n
      where n.id = (v_pack ->> 'notebook_id')::uuid
        and n.user_id = p_user_id
        and n.archived_at is null
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
    and domain = 'note'
    and mode = p_mode
    and status in ('active', 'paused');

  insert into public.study_sessions (
    user_id, device_id, domain, mode, purpose, ordering, scope,
    optional_count, seed, snapshot, candidate_items, candidate_count,
    progress_revision, cursor, has_more, next_sequence, status,
    create_request_id, create_fingerprint
  ) values (
    p_user_id, p_device_id, 'note', p_mode, p_purpose, p_ordering, p_scope,
    p_optional_count, p_seed, p_snapshot, p_candidate_items,
    jsonb_array_length(p_candidate_items), p_progress_revision, p_cursor,
    p_has_more, 0, 'active', p_create_request_id, p_create_fingerprint
  ) returning * into v_created;

  return v_created;
end;
$$;

revoke all on function public.create_note_study_session_v1(
  uuid, uuid, text, text, text, jsonb, integer, text, jsonb, jsonb,
  bigint, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.create_note_study_session_v1(
  uuid, uuid, text, text, text, jsonb, integer, text, jsonb, jsonb,
  bigint, text, boolean, text, text
) to service_role;

-- 4. record_note_study_observation_v1 --------------------------------------
create or replace function public.record_note_study_observation_v1(
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
  v_note public.notebook_notes%rowtype;
  v_read public.note_read_state%rowtype;
  v_existing public.study_observations%rowtype;
  v_observation_id uuid := gen_random_uuid();
  v_progress_json jsonb := 'null'::jsonb;
  v_result jsonb;
  v_effective_at timestamptz;
  v_projection_applied boolean := false;
begin
  if p_user_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_session_id is null or p_item_id is null
     or p_sequence < 0 or p_sequence > 9007199254740991
     or p_action not in ('opened', 'read_completed', 'skipped', 'session_paused')
     or p_mode not in ('sequential', 'recent')
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

  if not found or v_session.domain <> 'note'
     or v_session.status not in ('active', 'paused', 'abandoned') then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_NOT_ACTIVE';
  end if;
  if v_session.device_id is distinct from p_device_id or v_session.mode <> p_mode then
    raise exception using errcode = '22023', message = 'STUDY_SESSION_ACTOR_MISMATCH';
  end if;
  if p_sequence > v_session.next_sequence then
    raise exception using errcode = '40001', message = 'STUDY_SEQUENCE_GAP';
  elsif p_sequence < v_session.next_sequence then
    raise exception using errcode = '22023', message = 'STUDY_SEQUENCE_ALREADY_APPLIED';
  end if;

  select n.* into v_note
  from public.notebook_notes n
  where n.id = p_item_id
    and n.user_id = p_user_id
    and n.archived_at is null
    and (
      jsonb_array_length(v_session.scope -> 'notebook_ids') = 0
      or exists (
        select 1
        from jsonb_array_elements_text(v_session.scope -> 'notebook_ids') scoped(notebook_id)
        where scoped.notebook_id::uuid = n.notebook_id
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

  if p_action in ('opened', 'read_completed') then
    insert into public.note_read_state (user_id, note_id)
    values (p_user_id, p_item_id)
    on conflict (user_id, note_id) do nothing;

    select * into v_read
    from public.note_read_state r
    where r.user_id = p_user_id and r.note_id = p_item_id
    for update;

    if p_action = 'opened' then
      if v_read.last_opened_at is null or v_effective_at > v_read.last_opened_at then
        update public.note_read_state
        set last_opened_at = v_effective_at, updated_at = now()
        where user_id = p_user_id and note_id = p_item_id
        returning * into v_read;
        v_projection_applied := true;
      end if;
    else
      if v_read.last_completed_at is null or v_effective_at > v_read.last_completed_at then
        update public.note_read_state
        set last_completed_at = v_effective_at,
            last_opened_at = greatest(coalesce(last_opened_at, v_effective_at), v_effective_at),
            completed_count = completed_count + 1,
            updated_at = now()
        where user_id = p_user_id and note_id = p_item_id
        returning * into v_read;
        v_projection_applied := true;
      end if;
    end if;
  else
    select * into v_read
    from public.note_read_state r
    where r.user_id = p_user_id and r.note_id = p_item_id;
  end if;

  if v_read.user_id is not null then
    v_progress_json := jsonb_build_object(
      'last_opened_at', v_read.last_opened_at,
      'last_completed_at', v_read.last_completed_at,
      'completed_count', v_read.completed_count
    );
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

  update public.study_sessions
  set next_sequence = next_sequence + 1,
      status = case when status = 'paused' then 'active' else status end,
      last_activity_at = now(),
      updated_at = now()
  where id = p_session_id;

  return v_result;
end;
$$;

revoke all on function public.record_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;

-- 5. skip_note_study_observation_v1 -----------------------------------------
-- Non-projecting tombstone that advances a session past a terminally rejected
-- observation, so later sequences do not stall in STUDY_SEQUENCE_GAP.
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
     or p_action not in ('opened', 'read_completed', 'skipped', 'session_paused')
     or p_mode is null
     or p_mode not in ('sequential', 'recent')
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
     or v_session.domain <> 'note'
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

revoke all on function public.skip_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.skip_note_study_observation_v1(
  uuid, uuid, text, uuid, bigint, uuid, text, text, timestamptz
) to service_role;
