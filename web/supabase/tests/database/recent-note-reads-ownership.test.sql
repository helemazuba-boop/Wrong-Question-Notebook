begin;
create extension if not exists pgtap with schema extensions;
select plan(5);
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-000000000001', 'ci-reads-owner@example.invalid'),
  ('f2000000-0000-4000-8000-000000000002', 'ci-reads-other@example.invalid');
insert into public.subjects (id, user_id, name) values
  ('f2000000-0000-4000-8000-000000000011', 'f2000000-0000-4000-8000-000000000001', 'CI reads A'),
  ('f2000000-0000-4000-8000-000000000012', 'f2000000-0000-4000-8000-000000000002', 'CI reads B');
insert into public.notebooks (id, user_id, subject_id, title) values
  ('f2000000-0000-4000-8000-000000000021', 'f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000011', 'CI private A'),
  ('f2000000-0000-4000-8000-000000000022', 'f2000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000012', 'CI private B');
insert into public.notebook_notes (id, user_id, notebook_id, title, content) values
  ('f2000000-0000-4000-8000-000000000031', 'f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000021', 'Private A note', 'Owner A content'),
  ('f2000000-0000-4000-8000-000000000032', 'f2000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000022', 'Private B note', 'Owner B content');
insert into public.note_read_state (user_id, note_id, last_opened_at) values
  ('f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000031', now()),
  ('f2000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000032', now());
select is(has_function_privilege('authenticated', 'public.get_recent_note_reads_v2(uuid,uuid,integer)', 'EXECUTE'), true, 'ordinary users can call the recent-read projection');
select is(has_function_privilege('anon', 'public.get_recent_note_reads_v2(uuid,uuid,integer)', 'EXECUTE'), false, 'anonymous clients cannot call the recent-read projection');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*)::integer from public.get_recent_note_reads_v2('f2000000-0000-4000-8000-000000000001')), 1, 'an ordinary user reads their own recent note');
select is((select count(*)::integer from public.get_recent_note_reads_v2('f2000000-0000-4000-8000-000000000002')), 0, 'a forged user ID cannot expose another user recent notes');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::integer from public.get_recent_note_reads_v2('f2000000-0000-4000-8000-000000000002')), 1, 'the backend service projection retains its existing access');
select * from finish();
rollback;
