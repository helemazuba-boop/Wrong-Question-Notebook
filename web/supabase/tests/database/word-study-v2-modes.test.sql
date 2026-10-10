begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email)
values ('f1000000-0000-4000-8000-000000000001', 'ci-study-modes@example.invalid');
insert into public.word_decks (id, user_id, title, source, is_system)
values ('f1000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'CI v2 modes', 'user', false);
insert into public.word_entries (id, deck_id, word, normalized_word, meaning, sort_index)
values ('f1000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000002', 'durable', 'durable', '持久的', 0);
insert into public.study_sessions (
  id, user_id, domain, mode, purpose, ordering, scope, seed, snapshot,
  candidate_items, candidate_count, optional_count, create_request_id, create_fingerprint
) values (
  'f1000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000001',
  'word', 'intake', 'study', 'new_intake_v1',
  '{"deck_ids":["f1000000-0000-4000-8000-000000000002"],"include_mastered":false}',
  'ci_v2_mode_seed',
  '[{"deck_id":"f1000000-0000-4000-8000-000000000002","content_revision":1,"pack_revision":1,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}]',
  '[{"item_id":"f1000000-0000-4000-8000-000000000003","deck_id":"f1000000-0000-4000-8000-000000000002","ordinal":0}]',
  1, 1, 'ci_v2_mode_session_01', repeat('a', 64)
);

-- This fails if an older backfilled migration silently restores a v1 RPC.
create temporary table first_answer as
select public.record_study_observation_v1(
  'f1000000-0000-4000-8000-000000000001', null, 'ci_v2_mode_answer_01',
  'f1000000-0000-4000-8000-000000000004', 0,
  'f1000000-0000-4000-8000-000000000003', 'known', 'intake', '2026-10-10T00:00:00Z'
) as payload;
select is((select payload ->> 'projection_applied' from first_answer), 'true', 'v2 intake answers update progress');
select is((select mode from public.study_observations where session_id = 'f1000000-0000-4000-8000-000000000004'), 'intake', 'the canonical observation retains the v2 mode');
select is((select mode from public.word_review_events where session_id = 'f1000000-0000-4000-8000-000000000004'), 'intake', 'the legacy review projection retains the v2 mode');
select is((select next_sequence from public.study_sessions where id = 'f1000000-0000-4000-8000-000000000004'), 1::bigint, 'one answer consumes one sequence');
select is(public.record_study_observation_v1(
  'f1000000-0000-4000-8000-000000000001', null, 'ci_v2_mode_answer_01',
  'f1000000-0000-4000-8000-000000000004', 0,
  'f1000000-0000-4000-8000-000000000003', 'known', 'intake', '2026-10-10T00:00:00Z'
) ->> 'replayed', 'true', 'a v2 answer replays idempotently');
select is((select count(*)::integer from public.study_observations where session_id = 'f1000000-0000-4000-8000-000000000004'), 1, 'replaying a v2 answer creates no duplicate observation');

select * from finish();
rollback;
