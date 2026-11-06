-- Long-sequence cloud protocol SQL regression. Run after baseline word study
-- migrations and 20261105190000_word_study_long_sequence_v1.sql.
-- This file is rollback-only and uses a dedicated set of UUIDs.

begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'longseq-owner@example.invalid', '', now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'longseq-other@example.invalid', '', now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.esp32_devices (
  id, user_id, mac_address, hardware_id, access_token_hash, firmware_version,
  last_protocol_version, protocol_capabilities
) values
  ('a1000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000001', 'AA:10:00:00:00:01', 'AA:10:00:00:00:01', repeat('a', 64), 'longseq-test', 'v3', '[]'::jsonb),
  ('a1000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000002', 'AA:10:00:00:00:02', 'AA:10:00:00:00:02', repeat('b', 64), 'longseq-test', 'v3', '[]'::jsonb);

insert into public.word_decks (id, user_id, title, source, is_system) values
  ('a1000000-0000-4000-8000-000000000020', 'a1000000-0000-4000-8000-000000000001', 'Long-seq owned deck', 'user', false),
  ('a1000000-0000-4000-8000-000000000021', null, 'Long-seq system deck', 'system', true),
  ('a1000000-0000-4000-8000-000000000022', 'a1000000-0000-4000-8000-000000000002', 'Invisible deck', 'user', false),
  ('a1000000-0000-4000-8000-000000000023', 'a1000000-0000-4000-8000-000000000001', 'Archived deck', 'user', false);

update public.word_decks set archived_at = now() where id = 'a1000000-0000-4000-8000-000000000023';

insert into public.word_entries (id, deck_id, word, normalized_word, meaning, sort_index) values
  ('a1000000-0000-4000-8000-000000000030', 'a1000000-0000-4000-8000-000000000020', 'alpha', 'alpha', '甲', 0),
  ('a1000000-0000-4000-8000-000000000031', 'a1000000-0000-4000-8000-000000000020', 'beta', 'beta', '乙', 1),
  ('a1000000-0000-4000-8000-000000000032', 'a1000000-0000-4000-8000-000000000021', 'gamma', 'gamma', '丙', 0),
  ('a1000000-0000-4000-8000-000000000033', 'a1000000-0000-4000-8000-000000000022', 'hidden', 'hidden', '隐', 0);

-- Historical pack revision 7 is deliberately not the latest revision 8.
insert into public.word_packs (
  id, deck_id, revision, schema_version, format, compression, storage_path,
  sha256, byte_size, entry_count, status
) values
  ('a1000000-0000-4000-8000-000000000040', 'a1000000-0000-4000-8000-000000000020', 7, 1, 'jsonl', 'none', 'longseq/deck20/r7', repeat('7', 64), 100, 2, 'ready'),
  ('a1000000-0000-4000-8000-000000000041', 'a1000000-0000-4000-8000-000000000020', 8, 1, 'jsonl', 'none', 'longseq/deck20/r8', repeat('8', 64), 100, 2, 'ready'),
  ('a1000000-0000-4000-8000-000000000042', 'a1000000-0000-4000-8000-000000000021', 1, 1, 'jsonl', 'none', 'longseq/deck21/r1', repeat('1', 64), 100, 1, 'ready'),
  ('a1000000-0000-4000-8000-000000000043', 'a1000000-0000-4000-8000-000000000022', 1, 1, 'jsonl', 'none', 'longseq/deck22/r1', repeat('2', 64), 100, 1, 'ready');

-- An unrelated active session and one durable observation must survive.
insert into public.study_sessions (
  id, user_id, device_id, domain, mode, purpose, ordering, scope, seed,
  snapshot, candidate_items, candidate_count, optional_count,
  create_request_id, create_fingerprint
) values (
  'a1000000-0000-4000-8000-000000000050',
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000010',
  'word', 'sequential', 'study', 'sequential',
  '{"deck_ids":["a1000000-0000-4000-8000-000000000020"],"include_mastered":true}'::jsonb,
  'old_seed',
  '[{"deck_id":"a1000000-0000-4000-8000-000000000020","content_revision":1,"pack_revision":7,"sha256":"7777777777777777777777777777777777777777777777777777777777777777"}]'::jsonb,
  '[{"item_id":"a1000000-0000-4000-8000-000000000030","deck_id":"a1000000-0000-4000-8000-000000000020","ordinal":0}]'::jsonb,
  1, 1, 'old_session_request_0001', repeat('c', 64)
);

insert into public.study_observations (
  id, user_id, device_id, request_id, session_id, sequence, item_id,
  action, mode, occurred_at, result
) values (
  'a1000000-0000-4000-8000-000000000051',
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000010',
  'old_observation_request_01',
  'a1000000-0000-4000-8000-000000000050',
  0,
  'a1000000-0000-4000-8000-000000000030',
  'shown', 'sequential', '2026-11-01T00:00:00Z',
  '{"observation_id":"a1000000-0000-4000-8000-000000000051","session_id":"a1000000-0000-4000-8000-000000000050","sequence":0,"item_id":"a1000000-0000-4000-8000-000000000030","action":"shown","progress":null,"projection_applied":false,"replayed":false}'::jsonb
);

-- Ordinary (non-local) sessions in other word modes. Batch compatibility must
-- remain intact for all modes, not just local sequential sessions.
insert into public.study_sessions (
  id, user_id, device_id, domain, mode, purpose, ordering, scope, seed,
  snapshot, candidate_items, candidate_count, optional_count,
  create_request_id, create_fingerprint
) values
  ('a1000000-0000-4000-8000-000000000070',
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000010',
   'word', 'review', 'study', 'due_queue_v1',
   '{"deck_ids":["a1000000-0000-4000-8000-000000000020","a1000000-0000-4000-8000-000000000021"],"include_mastered":true}'::jsonb,
   'review_seed', '[]'::jsonb,
   '[{"item_id":"a1000000-0000-4000-8000-000000000030","deck_id":"a1000000-0000-4000-8000-000000000020","ordinal":0},{"item_id":"a1000000-0000-4000-8000-000000000032","deck_id":"a1000000-0000-4000-8000-000000000021","ordinal":1}]'::jsonb,
   2, 2, 'review_session_request_01', repeat('1', 64)),
  ('a1000000-0000-4000-8000-000000000071',
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000010',
   'word', 'intake', 'study', 'new_intake_v1',
   '{"deck_ids":["a1000000-0000-4000-8000-000000000020","a1000000-0000-4000-8000-000000000021"],"include_mastered":true}'::jsonb,
   'intake_seed', '[]'::jsonb,
   '[{"item_id":"a1000000-0000-4000-8000-000000000031","deck_id":"a1000000-0000-4000-8000-000000000020","ordinal":0}]'::jsonb,
   1, 1, 'intake_session_request_01', repeat('2', 64)),
  ('a1000000-0000-4000-8000-000000000072',
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000010',
   'word', 'sequential', 'study', 'sequential',
   '{"deck_ids":["a1000000-0000-4000-8000-000000000020"],"include_mastered":true}'::jsonb,
   'expired_seed', '[]'::jsonb,
   '[{"item_id":"a1000000-0000-4000-8000-000000000030","deck_id":"a1000000-0000-4000-8000-000000000020","ordinal":0}]'::jsonb,
   1, 1, 'expired_session_request_1', repeat('3', 64));

update public.study_sessions
set expires_at = now() - interval '1 day'
where id = 'a1000000-0000-4000-8000-000000000072'::uuid;

insert into public.study_observations (
  id, user_id, device_id, request_id, session_id, sequence, item_id,
  action, mode, occurred_at, result
) values (
  'a1000000-0000-4000-8000-000000000073',
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000010',
  'expired_existing_request_01',
  'a1000000-0000-4000-8000-000000000072',
  0,
  'a1000000-0000-4000-8000-000000000030',
  'shown', 'sequential', '2026-10-01T00:00:00Z',
  '{"observation_id":"a1000000-0000-4000-8000-000000000073","session_id":"a1000000-0000-4000-8000-000000000072","sequence":0,"item_id":"a1000000-0000-4000-8000-000000000030","action":"shown","progress":null,"projection_applied":false,"replayed":false}'::jsonb
);

do $$
declare
  v_user uuid := 'a1000000-0000-4000-8000-000000000001'::uuid;
  v_other_user uuid := 'a1000000-0000-4000-8000-000000000002'::uuid;
  v_device uuid := 'a1000000-0000-4000-8000-000000000010'::uuid;
  v_other_device uuid := 'a1000000-0000-4000-8000-000000000011'::uuid;
  v_session uuid := 'a1000000-0000-4000-8000-000000000060'::uuid;
  v_deck1 uuid := 'a1000000-0000-4000-8000-000000000020'::uuid;
  v_deck2 uuid := 'a1000000-0000-4000-8000-000000000021'::uuid;
  v_hidden uuid := 'a1000000-0000-4000-8000-000000000022'::uuid;
  v_item1 uuid := 'a1000000-0000-4000-8000-000000000030'::uuid;
  v_item2 uuid := 'a1000000-0000-4000-8000-000000000031'::uuid;
  v_item3 uuid := 'a1000000-0000-4000-8000-000000000032'::uuid;
  v_scope jsonb;
  v_snapshot jsonb;
  v_items jsonb;
  v_result jsonb;
  v_batch jsonb;
  v_count integer;
  v_fp text := repeat('d', 64);
  v_action text;
begin
  v_scope := jsonb_build_object('deck_ids', jsonb_build_array(v_deck1::text, v_deck2::text), 'include_mastered', true);
  v_snapshot := jsonb_build_array(
    jsonb_build_object('deck_id', v_deck1::text, 'content_revision', 7, 'pack_revision', 7, 'sha256', repeat('7', 64)),
    jsonb_build_object('deck_id', v_deck2::text, 'content_revision', 1, 'pack_revision', 1, 'sha256', repeat('1', 64))
  );
  v_items := jsonb_build_array(
    jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck1::text, 'ordinal', 0),
    jsonb_build_object('item_id', v_item2::text, 'deck_id', v_deck1::text, 'ordinal', 1),
    jsonb_build_object('item_id', v_item3::text, 'deck_id', v_deck2::text, 'ordinal', 2)
  );

  -- Actor checks: a device owned by another user cannot register for this user.
  begin
    perform public.register_local_word_study_session_v1(v_user, v_other_device, v_session, 'local_register_req_0001', v_fp, v_scope, 'seed', 0, v_snapshot, v_items);
    raise exception 'FAIL: foreign device was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_DEVICE_NOT_OWNED%' then raise; end if;
  end;

  -- Invisible and archived decks are rejected.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0002', v_fp,
      jsonb_build_object('deck_ids', jsonb_build_array(v_hidden::text), 'include_mastered', true),
      'seed', 0,
      jsonb_build_array(jsonb_build_object('deck_id', v_hidden::text, 'content_revision', 1, 'pack_revision', 1, 'sha256', repeat('2', 64))),
      jsonb_build_array(jsonb_build_object('item_id', 'a1000000-0000-4000-8000-000000000033'::uuid::text, 'deck_id', v_hidden::text, 'ordinal', 0))
    );
    raise exception 'FAIL: invisible deck was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_DECK_NOT_VISIBLE%' then raise; end if;
  end;

  -- Scope/snapshot set equality: extra pin with no scope deck.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0003', v_fp,
      jsonb_build_object('deck_ids', jsonb_build_array(v_deck1::text), 'include_mastered', true),
      'seed', 0, v_snapshot, v_items
    );
    raise exception 'FAIL: extra snapshot pin was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SCOPE_SNAPSHOT_MISMATCH%' and sqlerrm not like '%WORD_LOCAL_SNAPSHOT_INVALID%' then raise; end if;
  end;

  -- Wrong SHA is rejected while advisory content_revision stays unverified.
  begin
    -- Replace only the trusted pack SHA. Advisory content_revision remains 7
    -- and has no independent historical source to validate.
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0004', v_fp, v_scope, 'seed', 0,
      jsonb_set(v_snapshot, '{0,sha256}', to_jsonb(repeat('9', 64))),
      v_items
    );
    raise exception 'FAIL: wrong pack SHA was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_PACK_NOT_FOUND%' then raise; end if;
  end;

  -- include_mastered missing or JSON null cannot slip through three-valued SQL.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0013', v_fp,
      jsonb_build_object('deck_ids', jsonb_build_array(v_deck1::text, v_deck2::text)),
      'seed', 0, v_snapshot, v_items
    );
    raise exception 'FAIL: missing include_mastered was accepted';
  exception when others then
    if sqlerrm not like '%INVALID_STUDY_SESSION%' then raise; end if;
  end;
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0014', v_fp,
      jsonb_build_object('deck_ids', jsonb_build_array(v_deck1::text, v_deck2::text), 'include_mastered', null),
      'seed', 0, v_snapshot, v_items
    );
    raise exception 'FAIL: null include_mastered was accepted';
  exception when others then
    if sqlerrm not like '%INVALID_STUDY_SESSION%' then raise; end if;
  end;

  -- Missing / null snapshot fields are rejected at the SQL boundary.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0015', v_fp, v_scope, 'seed', 0,
      jsonb_build_array(
        jsonb_build_object('deck_id', v_deck1::text, 'pack_revision', 7, 'sha256', repeat('7', 64)),
        v_snapshot -> 1
      ), v_items
    );
    raise exception 'FAIL: missing content_revision was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SNAPSHOT_INVALID%' then raise; end if;
  end;
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0016', v_fp, v_scope, 'seed', 0,
      jsonb_build_array(
        jsonb_build_object('deck_id', v_deck1::text, 'content_revision', null, 'pack_revision', 7, 'sha256', repeat('7', 64)),
        v_snapshot -> 1
      ), v_items
    );
    raise exception 'FAIL: null content_revision was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SNAPSHOT_INVALID%' then raise; end if;
  end;
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0017', v_fp, v_scope, 'seed', 0,
      jsonb_build_array(
        jsonb_build_object('deck_id', v_deck1::text, 'content_revision', 7, 'sha256', repeat('7', 64)),
        v_snapshot -> 1
      ), v_items
    );
    raise exception 'FAIL: missing pack_revision was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SNAPSHOT_INVALID%' then raise; end if;
  end;

  -- Real array order: [ordinal 1, ordinal 0] is a set but not a valid sequence.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0018', v_fp, v_scope, 'seed', 0, v_snapshot,
      jsonb_build_array(
        jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck1::text, 'ordinal', 1),
        jsonb_build_object('item_id', v_item2::text, 'deck_id', v_deck1::text, 'ordinal', 0)
      )
    );
    raise exception 'FAIL: reversed ordinal array was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_ORDINAL_INVALID%' then raise; end if;
  end;

  -- Candidate outside scope.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0005', v_fp, v_scope, 'seed', 0, v_snapshot,
      v_items || jsonb_build_array(jsonb_build_object('item_id', 'a1000000-0000-4000-8000-000000000033'::uuid::text, 'deck_id', v_hidden::text, 'ordinal', 3))
    );
    raise exception 'FAIL: out-of-scope candidate was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_ITEM_NOT_IN_SCOPE%' then raise; end if;
  end;

  -- Entry not in declared deck.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0006', v_fp, v_scope, 'seed', 0, v_snapshot,
      jsonb_build_array(jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck2::text, 'ordinal', 0))
    );
    raise exception 'FAIL: wrong-deck entry was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_ITEM_NOT_IN_DECK%' then raise; end if;
  end;

  -- Duplicate ordinal / duplicate item ID.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0007', v_fp, v_scope, 'seed', 0, v_snapshot,
      jsonb_build_array(
        jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck1::text, 'ordinal', 0),
        jsonb_build_object('item_id', v_item2::text, 'deck_id', v_deck1::text, 'ordinal', 0)
      )
    );
    raise exception 'FAIL: duplicate ordinal was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_ORDINAL_INVALID%' then raise; end if;
  end;
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0008', v_fp, v_scope, 'seed', 0, v_snapshot,
      jsonb_build_array(
        jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck1::text, 'ordinal', 0),
        jsonb_build_object('item_id', v_item1::text, 'deck_id', v_deck1::text, 'ordinal', 1)
      )
    );
    raise exception 'FAIL: duplicate item ID was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_ITEM_DUPLICATE%' then raise; end if;
  end;

  -- Successful registration uses a historical (non-latest) READY pack.
  v_result := public.register_local_word_study_session_v1(
    v_user, v_device, v_session, 'local_register_req_0009', v_fp,
    v_scope, 'seed', 3507, v_snapshot, v_items
  );
  if v_result ->> 'replayed' <> 'false' or v_result ->> 'registered' <> 'true' then
    raise exception 'FAIL: first registration result %', v_result;
  end if;
  select count(*) into v_count from public.study_sessions
  where id = v_session and local_session = true and local_start_index = 3507
    and optional_count = 3 and candidate_count = 3
    and domain = 'word' and mode = 'sequential' and purpose = 'study'
    and ordering = 'sequential';
  if v_count <> 1 then raise exception 'FAIL: local session marker/candidates'; end if;
  select count(*) into v_count from public.study_sessions
  where id = 'a1000000-0000-4000-8000-000000000050'::uuid and status = 'active';
  if v_count <> 1 then raise exception 'FAIL: prior active session was overwritten'; end if;

  -- Same stable ID + same semantics across a different request_id/boot metadata
  -- is a replay. The route excludes metadata from the fingerprint; SQL compares
  -- the immutable semantic fingerprint and stored fields.
  v_result := public.register_local_word_study_session_v1(
    v_user, v_device, v_session, 'local_register_req_0010', v_fp,
    v_scope, 'seed', 3507, v_snapshot, v_items
  );
  if v_result ->> 'replayed' <> 'true' then
    raise exception 'FAIL: cross-boot replay was not idempotent: %', v_result;
  end if;

  -- Different immutable semantics with same stable ID is a conflict.
  begin
    perform public.register_local_word_study_session_v1(
      v_user, v_device, v_session, 'local_register_req_0011', repeat('e', 64),
      v_scope, 'seed', 3508, v_snapshot, v_items
    );
    raise exception 'FAIL: semantic conflict was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SESSION_CONFLICT%' then raise; end if;
  end;

  -- Another actor cannot claim the stable session ID.
  begin
    perform public.register_local_word_study_session_v1(
      v_other_user, v_other_device, v_session, 'local_register_req_0012', v_fp,
      v_scope, 'seed', 3507, v_snapshot, v_items
    );
    raise exception 'FAIL: actor confusion was accepted';
  exception when others then
    if sqlerrm not like '%WORD_LOCAL_SESSION_ACTOR_CONFLICT%' then raise; end if;
  end;

  -- Batch: all three accepted, including a known/unknown projection.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'longseq_observation_req_01', 'sequence', 0, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:00Z'),
    jsonb_build_object('request_id', 'longseq_observation_req_02', 'sequence', 1, 'item_id', v_item2::text, 'action', 'known', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:01Z'),
    jsonb_build_object('request_id', 'longseq_observation_req_03', 'sequence', 2, 'item_id', v_item3::text, 'action', 'unknown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:02Z')
  );
  v_result := public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
  if jsonb_array_length(v_result -> 'accepted') <> 3 or v_result -> 'failure' <> 'null'::jsonb then
    raise exception 'FAIL: full batch result %', v_result;
  end if;
  select count(*) into v_count from public.study_observations where session_id = v_session;
  if v_count <> 3 then raise exception 'FAIL: full batch durable count %', v_count; end if;
  select count(*) into v_count from public.study_observations
  where session_id = 'a1000000-0000-4000-8000-000000000050'::uuid;
  if v_count <> 1 then raise exception 'FAIL: old observation was removed'; end if;

  -- Replayed prefix: same request IDs and exact semantics. No duplicate projection.
  v_result := public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
  if jsonb_array_length(v_result -> 'accepted') <> 3
     or (v_result -> 'accepted' -> 0 ->> 'replayed') <> 'true' then
    raise exception 'FAIL: replayed prefix result %', v_result;
  end if;
  select count(*) into v_count from public.study_observations where session_id = v_session;
  if v_count <> 3 then raise exception 'FAIL: replay duplicated projections'; end if;

  -- Same request ID with different semantics must not be ACKed.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'longseq_observation_req_01', 'sequence', 0, 'item_id', v_item1::text, 'action', 'unknown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:00Z')
  );
  v_result := public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
  if v_result #>> '{failure,code}' <> 'REQUEST_ID_REUSED'
     or (v_result -> 'failure' ->> 'retryable') <> 'false' then
    raise exception 'FAIL: forged replay result %', v_result;
  end if;
  select action into strict v_action from public.study_observations
  where request_id = 'longseq_observation_req_01';
  if v_action <> 'shown' then
    raise exception 'FAIL: forged replay mutated original observation';
  end if;

  -- Middle semantic failure: accepted first item, failure at second, third not attempted.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'longseq_observation_req_04', 'sequence', 3, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:03Z'),
    jsonb_build_object('request_id', 'longseq_observation_req_05', 'sequence', 4, 'item_id', v_item2::text, 'action', 'shown', 'mode', 'random', 'occurred_at', '2026-11-02T00:00:04Z'),
    jsonb_build_object('request_id', 'longseq_observation_req_06', 'sequence', 5, 'item_id', v_item3::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:05Z')
  );
  v_result := public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
  if jsonb_array_length(v_result -> 'accepted') <> 1
     or v_result #>> '{failure,request_id}' <> 'longseq_observation_req_05'
     or v_result #>> '{failure,sequence}' <> '4' then
    raise exception 'FAIL: mid-batch prefix result %', v_result;
  end if;
  select count(*) into v_count from public.study_observations
  where request_id in ('longseq_observation_req_04', 'longseq_observation_req_05', 'longseq_observation_req_06');
  if v_count <> 1 then
    raise exception 'FAIL: failed item or its suffix was committed: %', v_count;
  end if;
  select next_sequence into v_count from public.study_sessions where id = v_session;
  if v_count <> 4 then raise exception 'FAIL: session next_sequence is %', v_count; end if;

  -- A sequence gap is a known semantic failure, not a whole-batch rollback.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'longseq_observation_req_07', 'sequence', 9, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:09Z')
  );
  v_result := public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
  if v_result #>> '{failure,code}' <> 'SEQUENCE_GAP'
     or (v_result -> 'failure' ->> 'retryable') <> 'true'
     or jsonb_array_length(v_result -> 'accepted') <> 0 then
    raise exception 'FAIL: sequence gap result %', v_result;
  end if;

  -- All word modes remain batch-compatible: review and intake sessions use
  -- their own locked mode; the batch RPC does not hard-code sequential.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'review_batch_request_0001', 'sequence', 0, 'item_id', v_item1::text, 'action', 'known', 'mode', 'review', 'occurred_at', '2026-11-02T01:00:00Z'),
    jsonb_build_object('request_id', 'review_batch_request_0002', 'sequence', 1, 'item_id', v_item3::text, 'action', 'shown', 'mode', 'review', 'occurred_at', '2026-11-02T01:00:01Z')
  );
  v_result := public.record_word_study_observation_batch_v1(
    v_user, v_device, 'a1000000-0000-4000-8000-000000000070'::uuid, v_batch
  );
  if jsonb_array_length(v_result -> 'accepted') <> 2
     or v_result -> 'failure' <> 'null'::jsonb then
    raise exception 'FAIL: review batch result %', v_result;
  end if;

  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'intake_batch_request_0001', 'sequence', 0, 'item_id', v_item2::text, 'action', 'unknown', 'mode', 'intake', 'occurred_at', '2026-11-02T02:00:00Z')
  );
  v_result := public.record_word_study_observation_batch_v1(
    v_user, v_device, 'a1000000-0000-4000-8000-000000000071'::uuid, v_batch
  );
  if jsonb_array_length(v_result -> 'accepted') <> 1
     or v_result -> 'failure' <> 'null'::jsonb then
    raise exception 'FAIL: intake batch result %', v_result;
  end if;

  -- Expired session: an already durable request still replays through the
  -- original RPC's replay path; a new request is a terminal semantic failure.
  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'expired_existing_request_01', 'sequence', 0, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-10-01T00:00:00Z')
  );
  v_result := public.record_word_study_observation_batch_v1(
    v_user, v_device, 'a1000000-0000-4000-8000-000000000072'::uuid, v_batch
  );
  if jsonb_array_length(v_result -> 'accepted') <> 1
     or (v_result -> 'accepted' -> 0 ->> 'replayed') <> 'true'
     or v_result -> 'failure' <> 'null'::jsonb then
    raise exception 'FAIL: expired replay result %', v_result;
  end if;

  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'expired_new_request_000001', 'sequence', 1, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-10-01T00:00:01Z')
  );
  v_result := public.record_word_study_observation_batch_v1(
    v_user, v_device, 'a1000000-0000-4000-8000-000000000072'::uuid, v_batch
  );
  if v_result #>> '{failure,code}' <> 'SESSION_NOT_ACTIVE'
     or jsonb_array_length(v_result -> 'accepted') <> 0 then
    raise exception 'FAIL: expired new request result %', v_result;
  end if;

  -- Malformed RPC input cannot produce a successful receipt.
  begin
    perform public.record_word_study_observation_batch_v1(
      v_user, v_device, v_session,
      jsonb_build_array(jsonb_build_object('request_id', 'malformed_request_00001', 'sequence', 4, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential'))
    );
    raise exception 'FAIL: malformed observation was accepted';
  exception when others then
    if sqlerrm not like '%INVALID_STUDY_OBSERVATION%' then raise; end if;
  end;
  begin
    perform public.record_word_study_observation_batch_v1(
      v_user, v_device, v_session,
      jsonb_build_array(
        jsonb_build_object('request_id', 'bad_prefix_request_00001', 'sequence', 4, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:00Z'),
        jsonb_build_object('request_id', 'bad_prefix_request_00002', 'sequence', 6, 'item_id', v_item2::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T00:00:01Z')
      )
    );
    raise exception 'FAIL: non-consecutive prefix was accepted';
  exception when others then
    if sqlerrm not like '%INVALID_STUDY_OBSERVATION%' then raise; end if;
  end;

  -- Unknown DB error after one accepted fact: the whole transaction must roll
  -- back. A temporary trigger injects an unrelated projection failure on the
  -- second observation; the exception is NOT whitelisted by the batch RPC.
  create function pg_temp.inject_unexpected_batch_error()
  returns trigger language plpgsql as $trigger$
  begin
    if new.request_id = 'unexpected_db_error_req_02' then
      raise exception using errcode = 'P0001', message = 'injected unexpected projection failure';
    end if;
    return new;
  end;
  $trigger$;

  create trigger word_review_events_unexpected_batch_error
  before insert on public.word_review_events
  for each row execute function pg_temp.inject_unexpected_batch_error();

  v_batch := jsonb_build_array(
    jsonb_build_object('request_id', 'unexpected_db_error_req_01', 'sequence', 4, 'item_id', v_item1::text, 'action', 'shown', 'mode', 'sequential', 'occurred_at', '2026-11-02T03:00:00Z'),
    jsonb_build_object('request_id', 'unexpected_db_error_req_02', 'sequence', 5, 'item_id', v_item2::text, 'action', 'unknown', 'mode', 'sequential', 'occurred_at', '2026-11-02T03:00:01Z')
  );
  begin
    perform public.record_word_study_observation_batch_v1(v_user, v_device, v_session, v_batch);
    raise exception 'FAIL: unknown DB error became a terminal receipt';
  exception when others then
    if sqlerrm not like '%injected unexpected projection failure%' then
      raise exception 'FAIL: unexpected batch error was misclassified: %', sqlerrm;
    end if;
  end;
  drop trigger word_review_events_unexpected_batch_error on public.word_review_events;
  drop function pg_temp.inject_unexpected_batch_error();

  select count(*) into v_count from public.study_observations
  where request_id in ('unexpected_db_error_req_01', 'unexpected_db_error_req_02');
  if v_count <> 0 then
    raise exception 'FAIL: accepted prefix survived unknown DB error: %', v_count;
  end if;
  select next_sequence into v_count from public.study_sessions where id = v_session;
  if v_count <> 4 then
    raise exception 'FAIL: session advanced during rolled-back batch: %', v_count;
  end if;
end;
$$;

-- Personal snapshots are independent from shared packs and learning writes.
do $$
declare
 u uuid:='a1000000-0000-4000-8000-000000000001';
 d uuid:='a1000000-0000-4000-8000-000000000010';
 other_d uuid:='a1000000-0000-4000-8000-000000000011';
 sid uuid:='a1000000-0000-4000-8000-000000000099';
 pins jsonb; scope jsonb; items jsonb; result jsonb; replay jsonb; before_facts bigint;
begin
 select snapshot,candidate_items into pins,items from public.study_sessions
 where id='a1000000-0000-4000-8000-000000000060';
 if pins is null then raise exception 'FAIL: v1 fixture missing'; end if;
 scope=jsonb_build_object('deck_ids',jsonb_build_array('a1000000-0000-4000-8000-000000000020','a1000000-0000-4000-8000-000000000021'),'include_mastered',false);
 select count(*) into before_facts from public.study_observations;
 insert into public.word_progress(user_id,word_entry_id,status)
 values(u,'a1000000-0000-4000-8000-000000000030','mastered')
 on conflict(user_id,word_entry_id) do update set status='mastered';
 result=public.read_word_study_eligibility_v1(u,d,pins);
 if result->>'mastered_bitmap' not like '1__' or length(result->>'mastered_bitmap')<>3 then
  raise exception 'FAIL: eligibility bitmap did not preserve UUID order: %',result;
 end if;
 if result->>'item_ids_sha256'<>encode(extensions.digest(convert_to(
  'a1000000-0000-4000-8000-000000000030'||chr(10)||'a1000000-0000-4000-8000-000000000031'||chr(10)||'a1000000-0000-4000-8000-000000000032','UTF8'),'sha256'),'hex') then
  raise exception 'FAIL: eligibility UUID fingerprint drifted';
 end if;
 if before_facts<>(select count(*) from public.study_observations) then
  raise exception 'FAIL: read-only eligibility created learning facts';
 end if;
 begin
  perform public.read_word_study_eligibility_v1(u,other_d,pins);
  raise exception 'FAIL: foreign device read accepted';
 exception when others then
  if sqlerrm not like '%WORD_LOCAL_DEVICE_NOT_OWNED%' then raise; end if;
 end;
 begin
  perform public.read_word_study_eligibility_v1(u,d,jsonb_build_array(pins->0,pins->0));
  raise exception 'FAIL: duplicate snapshot accepted';
 exception when others then
  if sqlerrm not like '%WORD_LOCAL_SNAPSHOT_INVALID%' then raise; end if;
 end;
 result=public.register_local_word_study_session_v2(u,d,sid,'shuffle_register_request_01',repeat('e',64),scope,'fixed-round-seed',0,pins,items,'shuffle',41);
 replay=public.register_local_word_study_session_v2(u,d,sid,'shuffle_register_request_02',repeat('e',64),scope,'fixed-round-seed',0,pins,items,'shuffle',41);
 if result->>'registered'<>'true' or replay->>'replayed'<>'true' then raise exception 'FAIL: shuffle retry not idempotent'; end if;
 if not exists(select 1 from public.study_sessions where id=sid and mode='shuffle' and ordering='pure_random_v1' and progress_revision=41) then
  raise exception 'FAIL: local shuffle semantics were rewritten';
 end if;
 begin
  perform public.register_local_word_study_session_v2(u,d,sid,'shuffle_register_request_03',repeat('e',64),scope,'fixed-round-seed',0,pins,items,'shuffle',42);
  raise exception 'FAIL: immutable shuffle revision changed';
 exception when others then if sqlerrm not like '%WORD_LOCAL_SESSION_CONFLICT%' then raise; end if; end;
 result=public.record_word_study_observation_batch_v1(u,d,sid,jsonb_build_array(
  jsonb_build_object('request_id','shuffle_observation_req_01','sequence',0,'item_id',items->0->>'item_id','action','shown','mode','shuffle','occurred_at','2026-11-06T00:00:00Z')));
 if jsonb_array_length(result->'accepted')<>1 then raise exception 'FAIL: shuffle fact not accepted: %',result; end if;
 if has_function_privilege('anon','public.read_word_study_eligibility_v1(uuid,uuid,jsonb)','execute')
    or has_function_privilege('authenticated','public.register_local_word_study_session_v2(uuid,uuid,uuid,text,text,jsonb,text,bigint,jsonb,jsonb,text,bigint)','execute') then
  raise exception 'FAIL: device-bound functions exposed to public roles';
 end if;
 raise notice 'PASS: offline shuffle identity, bitmap, actor, revision, upload and grants';
end $$;

rollback;
