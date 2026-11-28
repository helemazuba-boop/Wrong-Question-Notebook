-- Preserve v1 registrations; new v2 registrations retain their original study mode.
alter table public.study_sessions drop constraint study_sessions_local_marker_v1_check;
alter table public.study_sessions add constraint study_sessions_local_marker_v1_check check (
 (local_session = false and local_start_index is null and local_fingerprint is null)
 or (local_session = true and domain = 'word' and purpose = 'study'
     and ((mode = 'sequential' and ordering = 'sequential')
          or (mode = 'shuffle' and ordering = 'pure_random_v1'))
     and local_start_index between 0 and 10000 and local_fingerprint ~ '^[0-9a-f]{64}$')
);

create or replace function public.register_local_word_study_session_v2(
  p_user_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_create_request_id text,
  p_fingerprint text,
  p_scope jsonb,
  p_seed text,
  p_start_index bigint,
  p_snapshot jsonb,
  p_candidate_items jsonb,
  p_mode text,
  p_progress_revision bigint
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
  if p_mode is null or p_mode not in ('sequential', 'shuffle')
     or p_progress_revision is null or p_progress_revision < 0 or p_progress_revision > 9007199254740991
     or p_user_id is null or p_device_id is null or p_session_id is null
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
     or (p_scope -> 'include_mastered') is distinct from to_jsonb(p_mode = 'sequential') then
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
    if v_existing.mode <> p_mode
       or v_existing.progress_revision <> p_progress_revision
       or v_existing.local_fingerprint <> p_fingerprint
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
    p_session_id, p_user_id, p_device_id, 'word', p_mode, 'study',
    case when p_mode = 'shuffle' then 'pure_random_v1' else 'sequential' end,
    p_scope, v_item_count, p_seed, p_snapshot, p_candidate_items, v_item_count,
    p_progress_revision, null, false, 0, 'active',
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

revoke all on function public.register_local_word_study_session_v2(
  uuid, uuid, uuid, text, text, jsonb, text, bigint, jsonb, jsonb, text, bigint
) from public, anon, authenticated;
grant execute on function public.register_local_word_study_session_v2(
  uuid, uuid, uuid, text, text, jsonb, text, bigint, jsonb, jsonb, text, bigint
) to service_role;

-- STABLE functions use the caller statement's MVCC snapshot for every read.
-- This function performs no progress or study writes.
create or replace function public.read_word_study_eligibility_v1(
 p_user_id uuid, p_device_id uuid, p_snapshot jsonb
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_pin jsonb; v_decks uuid[]; v_count integer; v_bitmap text; v_ids text; v_revision bigint;
begin
 if p_user_id is null or p_device_id is null or jsonb_typeof(p_snapshot) is distinct from 'array'
    or jsonb_array_length(p_snapshot) not between 1 and 32 then
  raise exception 'INVALID_WORD_ELIGIBILITY';
 end if;
 if not exists(select 1 from public.esp32_devices d where d.id=p_device_id and d.user_id=p_user_id) then
  raise exception 'WORD_LOCAL_DEVICE_NOT_OWNED';
 end if;
 for v_pin in select value from jsonb_array_elements(p_snapshot) loop
  if jsonb_typeof(v_pin) is distinct from 'object'
     or coalesce(v_pin->>'deck_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(v_pin->>'sha256','') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(v_pin->'pack_revision') is distinct from 'number'
     or (v_pin->>'pack_revision')::numeric not between 1 and 9007199254740991
     or trunc((v_pin->>'pack_revision')::numeric) <> (v_pin->>'pack_revision')::numeric then
   raise exception 'WORD_LOCAL_SNAPSHOT_INVALID';
  end if;
  if not exists(select 1 from public.word_decks d where d.id=(v_pin->>'deck_id')::uuid
     and d.is_active and d.archived_at is null and (d.is_system or d.user_id=p_user_id)) then
   raise exception 'WORD_LOCAL_DECK_NOT_VISIBLE';
  end if;
  if not exists(select 1 from public.word_packs p where p.deck_id=(v_pin->>'deck_id')::uuid
     and p.revision=(v_pin->>'pack_revision')::bigint and p.sha256=v_pin->>'sha256' and p.status='ready') then
   raise exception 'WORD_LOCAL_PACK_NOT_FOUND';
  end if;
  if (v_pin->>'deck_id')::uuid = any(coalesce(v_decks,'{}'::uuid[])) then
   raise exception 'WORD_LOCAL_SNAPSHOT_INVALID';
  end if;
  v_decks=array_append(v_decks,(v_pin->>'deck_id')::uuid);
 end loop;
 select count(*), string_agg(e.id::text,chr(10) order by e.id),
        string_agg(case when p.status='mastered' then '1' else '0' end,'' order by e.id)
 into v_count,v_ids,v_bitmap
 from (select id from public.word_entries where deck_id=any(v_decks) order by id limit 10001) e
 left join public.word_progress p on p.word_entry_id=e.id and p.user_id=p_user_id;
 if v_count not between 1 and 10000 then raise exception 'WORD_ELIGIBILITY_SIZE'; end if;
 select coalesce(max(sequence),0) into v_revision from public.word_change_log
 where user_id=p_user_id and entity_kind='progress';
 if v_revision > 9007199254740991 then raise exception 'WORD_ELIGIBILITY_REVISION'; end if;
 return jsonb_build_object('progress_revision',v_revision,
  'item_ids_sha256',encode(extensions.digest(convert_to(v_ids,'UTF8'),'sha256'),'hex'),
  'mastered_bitmap',v_bitmap);
end $$;
revoke all on function public.read_word_study_eligibility_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_word_study_eligibility_v1(uuid,uuid,jsonb) to service_role;
