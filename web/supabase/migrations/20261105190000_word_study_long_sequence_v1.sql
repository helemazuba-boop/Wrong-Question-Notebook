-- Long-sequence offline word study: stable device-generated session IDs and
-- bounded observation batches. Append-only: this migration adds columns,
-- indexes and service-role RPCs; it never rewrites or deletes sessions or
-- observations, and it never creates/replaces record_study_observation_v1.
--
-- content_revision has no immutable historical source in word_packs. We do not
-- pretend to verify it: the trusted pin is the exact historical READY pack
-- (deck_id, pack_revision, sha256). The device-declared content_revision is
-- retained in the snapshot as advisory metadata only.

alter table public.study_sessions
  add column if not exists local_session boolean not null default false,
  add column if not exists local_start_index bigint,
  add column if not exists local_fingerprint text;

alter table public.study_sessions
  drop constraint if exists study_sessions_local_marker_v1_check;
alter table public.study_sessions
  add constraint study_sessions_local_marker_v1_check check (
    (local_session = false and local_start_index is null and local_fingerprint is null)
    or (
      local_session = true
      and domain = 'word'
      and mode = 'sequential'
      and purpose = 'study'
      and ordering = 'sequential'
      and local_start_index between 0 and 10000
      and local_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

-- A stable session ID is globally unique. The RPC resolves the owner/fingerprint
-- collision before INSERT, so retries across boots are idempotent.
create unique index if not exists study_sessions_id_uidx
  on public.study_sessions (id);

create or replace function public.register_local_word_study_session_v1(
  p_user_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_create_request_id text,
  p_fingerprint text,
  p_scope jsonb,
  p_seed text,
  p_start_index bigint,
  p_snapshot jsonb,
  p_candidate_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.study_sessions%rowtype;
  v_deck_id uuid;
  v_item jsonb;
  v_snapshot_count integer;
  v_scope_count integer;
  v_item_count integer;
  v_position integer;
  v_ordinal bigint;
  v_declared_deck_id uuid;
  v_text text;
  v_number numeric;
begin
  if p_user_id is null or p_device_id is null or p_session_id is null
     or p_create_request_id !~ '^[A-Za-z0-9_-]{16,64}$'
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_seed !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_start_index is null or p_start_index < 0 or p_start_index > 10000
     or jsonb_typeof(p_scope) <> 'object'
     or jsonb_typeof(p_snapshot) <> 'array'
     or jsonb_typeof(p_candidate_items) <> 'array'
     or coalesce(jsonb_typeof(p_scope -> 'deck_ids'), '') <> 'array'
     -- Missing or JSON null include_mastered must fail explicitly; a plain
     -- inequality against 'true' would be SQL NULL and could slip through.
     or (p_scope -> 'include_mastered') is distinct from 'true'::jsonb then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_SESSION';
  end if;

  select count(*) into v_scope_count
  from jsonb_array_elements(p_scope -> 'deck_ids');
  if v_scope_count < 1 or v_scope_count > 32
     or exists (
       select 1 from jsonb_array_elements(p_scope -> 'deck_ids') scoped(value)
       where jsonb_typeof(scoped.value) <> 'string'
          or scoped.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
     or (select count(distinct value #>> '{}') from jsonb_array_elements(p_scope -> 'deck_ids')) <> v_scope_count then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_SESSION';
  end if;

  select count(*) into v_snapshot_count from jsonb_array_elements(p_snapshot);
  if v_snapshot_count < 1 or v_snapshot_count > 32
     or v_snapshot_count <> v_scope_count then
    raise exception using errcode = '22023', message = 'WORD_LOCAL_SNAPSHOT_INVALID';
  end if;

  -- Exact set equality between scope and snapshots: neither a missing pin nor
  -- an extra pin is allowed.
  if exists (
    select 1
    from jsonb_array_elements(p_scope -> 'deck_ids') scoped(value)
    where not exists (
      select 1 from jsonb_array_elements(p_snapshot) pinned(value)
      where jsonb_typeof(pinned.value) = 'object'
        and pinned.value ->> 'deck_id' = scoped.value #>> '{}'
    )
  ) or exists (
    select 1
    from jsonb_array_elements(p_snapshot) pinned(value)
    where not exists (
      select 1 from jsonb_array_elements(p_scope -> 'deck_ids') scoped(value)
      where scoped.value #>> '{}' = pinned.value ->> 'deck_id'
    )
  ) or (
    select count(distinct pinned.value ->> 'deck_id')
    from jsonb_array_elements(p_snapshot) pinned(value)
  ) <> v_snapshot_count then
    raise exception using errcode = '22023', message = 'WORD_LOCAL_SCOPE_SNAPSHOT_MISMATCH';
  end if;

  if not exists (
    select 1 from public.esp32_devices d
    where d.id = p_device_id and d.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'WORD_LOCAL_DEVICE_NOT_OWNED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('word-local-session:' || p_session_id::text, 0::bigint)
  );

  select * into v_existing from public.study_sessions s where s.id = p_session_id;
  if found then
    if v_existing.user_id <> p_user_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.local_session is not true then
      raise exception using errcode = '23505', message = 'WORD_LOCAL_SESSION_ACTOR_CONFLICT';
    end if;
    if v_existing.local_fingerprint <> p_fingerprint
       or v_existing.scope <> p_scope
       or v_existing.snapshot <> p_snapshot
       or v_existing.candidate_items <> p_candidate_items
       or v_existing.seed <> p_seed
       or v_existing.local_start_index <> p_start_index then
      raise exception using errcode = '23505', message = 'WORD_LOCAL_SESSION_CONFLICT';
    end if;
    return jsonb_build_object(
      'session_id', v_existing.id,
      'registered', true,
      'replayed', true
    );
  end if;

  -- Pin each deck with the same per-deck advisory lock pack pruning uses,
  -- in the same sorted order, before we validate the historical READY pack and
  -- insert the session. A concurrent prune must not delete a pack we just
  -- verified between the READY check below and the INSERT at the end of this
  -- transaction. pg_advisory_xact_lock is held until commit, so the lock spans
  -- both the word_packs validation loop and the study_sessions INSERT.
  for v_deck_id in
    select (value #>> '{}')::uuid from jsonb_array_elements(p_scope -> 'deck_ids') as t(value)
    order by value #>> '{}'
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'word-pack:' || v_deck_id::text,
        0::bigint
      )
    );
    if not exists (
      select 1 from public.word_decks d
      where d.id = v_deck_id
        and d.is_active = true
        and d.archived_at is null
        and (d.is_system = true or d.user_id = p_user_id)
    ) then
      raise exception using errcode = '42501', message = 'WORD_LOCAL_DECK_NOT_VISIBLE';
    end if;
  end loop;

  -- Strict snapshot fields. content_revision is advisory: there is no
  -- immutable historical source. The trusted pin is the exact historical
  -- READY word_packs row (deck_id, pack_revision, sha256).
  for v_item in select value from jsonb_array_elements(p_snapshot) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(jsonb_typeof(v_item -> 'deck_id'), '') <> 'string'
       or (v_item ->> 'deck_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(v_item -> 'content_revision'), '') <> 'number'
       or coalesce(jsonb_typeof(v_item -> 'pack_revision'), '') <> 'number'
       or coalesce(jsonb_typeof(v_item -> 'sha256'), '') <> 'string'
       or (v_item ->> 'sha256') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_SNAPSHOT_INVALID';
    end if;
    foreach v_text in array array['content_revision', 'pack_revision'] loop
      v_number := (v_item ->> v_text)::numeric;
      if v_number is null or v_number <> trunc(v_number)
         or v_number < 0 or v_number > 9007199254740991 then
        raise exception using errcode = '22023', message = 'WORD_LOCAL_SNAPSHOT_INVALID';
      end if;
    end loop;
    if coalesce((v_item ->> 'pack_revision')::numeric, 0) < 1 then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_SNAPSHOT_INVALID';
    end if;
    if not exists (
      select 1 from public.word_packs p
      where p.deck_id = (v_item ->> 'deck_id')::uuid
        and p.revision = (v_item ->> 'pack_revision')::bigint
        and p.sha256 = v_item ->> 'sha256'
        and p.status = 'ready'
    ) then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_PACK_NOT_FOUND';
    end if;
  end loop;

  select count(*) into v_item_count from jsonb_array_elements(p_candidate_items);
  if v_item_count < 1 or v_item_count > 500 then
    raise exception using errcode = '22023', message = 'INVALID_STUDY_SESSION';
  end if;
  if (
    select count(distinct value ->> 'item_id')
    from jsonb_array_elements(p_candidate_items)
  ) <> v_item_count then
    raise exception using errcode = '23505', message = 'WORD_LOCAL_ITEM_DUPLICATE';
  end if;

  -- WITH ORDINALITY enforces the actual array order: ordinal must equal the
  -- zero-based array position, not merely belong to the set 0..n-1.
  for v_item, v_position in
    select value, ordinality::integer - 1
    from jsonb_array_elements(p_candidate_items) with ordinality as t(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(jsonb_typeof(v_item -> 'item_id'), '') <> 'string'
       or (v_item ->> 'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(v_item -> 'deck_id'), '') <> 'string'
       or (v_item ->> 'deck_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(v_item -> 'ordinal'), '') <> 'number' then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_ORDINAL_INVALID';
    end if;
    v_number := (v_item ->> 'ordinal')::numeric;
    if v_number is null or v_number <> trunc(v_number)
       or v_number < 0 or v_number > 9007199254740991
       or v_number <> v_position then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_ORDINAL_INVALID';
    end if;
    v_ordinal := v_number::bigint;
    v_declared_deck_id := (v_item ->> 'deck_id')::uuid;
    if not exists (
      select 1 from jsonb_array_elements(p_scope -> 'deck_ids') scoped(value)
      where scoped.value #>> '{}' = v_declared_deck_id::text
    ) then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_ITEM_NOT_IN_SCOPE';
    end if;
    if not exists (
      select 1 from public.word_entries e
      where e.id = (v_item ->> 'item_id')::uuid
        and e.deck_id = v_declared_deck_id
    ) then
      raise exception using errcode = '22023', message = 'WORD_LOCAL_ITEM_NOT_IN_DECK';
    end if;
  end loop;

  insert into public.study_sessions (
    id, user_id, device_id, domain, mode, purpose, ordering,
    scope, optional_count, seed, snapshot, candidate_items, candidate_count,
    progress_revision, cursor, has_more, next_sequence, status,
    create_request_id, create_fingerprint,
    local_session, local_start_index, local_fingerprint
  ) values (
    p_session_id, p_user_id, p_device_id, 'word', 'sequential', 'study', 'sequential',
    p_scope, v_item_count, p_seed, p_snapshot, p_candidate_items, v_item_count,
    0, null, false, 0, 'active',
    p_create_request_id, p_fingerprint,
    true, p_start_index, p_fingerprint
  );
  -- No UPDATE/DELETE and no abandonment of other sessions.

  return jsonb_build_object(
    'session_id', p_session_id,
    'registered', true,
    'replayed', false
  );
end;
$$;

revoke all on function public.register_local_word_study_session_v1(
  uuid, uuid, uuid, text, text, jsonb, text, bigint, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.register_local_word_study_session_v1(
  uuid, uuid, uuid, text, text, jsonb, text, bigint, jsonb, jsonb
) to service_role;

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
