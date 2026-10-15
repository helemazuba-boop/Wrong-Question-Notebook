begin;
create extension if not exists pgtap with schema extensions;
select plan(21);
insert into auth.users (id, email) values
('a1210000-0000-4000-8000-000000000001', 'moderation-owner@example.invalid'),
('a1210000-0000-4000-8000-000000000002', 'moderation-staff@example.invalid'),
('a1210000-0000-4000-8000-000000000003', 'moderation-reporter@example.invalid');
update public.user_profiles set user_role = 'moderator' where id = 'a1210000-0000-4000-8000-000000000002';
insert into public.subjects (id, user_id, name) values
('b1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001', 'Moderation fixture');
insert into public.problem_sets (id, user_id, subject_id, name, sharing_level, is_listed) values
('c1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001',
 'b1210000-0000-4000-8000-000000000001', 'Reported notebook', 'public', true);
insert into public.problems (id, user_id, subject_id, title, status, parts) values
('d1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001',
 'b1210000-0000-4000-8000-000000000001', 'Original question', 'wrong', '[{"index":1,"type":"short_answer"}]');
insert into public.problem_set_reports (id, problem_set_id, reporter_user_id, reason) values
('e1210000-0000-4000-8000-000000000001', 'c1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000003', 'other'),
('e1210000-0000-4000-8000-000000000002', 'c1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001', 'other');
select ok(not has_function_privilege('authenticated', 'public.resolve_problem_set_report(uuid,uuid,text,text)', 'EXECUTE'),
 'moderation RPC is not directly exposed to user sessions');
select throws_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001', 'hide', 'Paused')$$,
 '42501', 'moderation_permission_denied', 'ordinary actor cannot use a trusted service to grant itself moderation');
update public.user_profiles set user_role = 'moderator' where id = 'a1210000-0000-4000-8000-000000000001';
select throws_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000001', 'hide', 'Paused')$$,
 '42501', 'cannot_moderate_own_content', 'staff cannot resolve a report on their own content');
update public.user_profiles set user_role = 'user' where id = 'a1210000-0000-4000-8000-000000000001';
update public.user_profiles set is_active = false where id = 'a1210000-0000-4000-8000-000000000002';
select throws_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000002', 'hide', 'Paused')$$,
 '42501', 'moderation_permission_denied', 'disabled staff cannot perform deferred moderation');
update public.user_profiles set is_active = true where id = 'a1210000-0000-4000-8000-000000000002';
select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000002', 'hide', 'Paused');
select is((select status from public.problem_set_reports where id = 'e1210000-0000-4000-8000-000000000001'), 'reviewed', 'resolution and feedback commit together');
select is((select sharing_level::text from public.problem_sets where id = 'c1210000-0000-4000-8000-000000000001'), 'private', 'hidden content no longer has shared visibility');
select is((select count(*)::integer from public.problems where id = 'd1210000-0000-4000-8000-000000000001'), 1, 'moderation preserves original questions');
select is((select count(*)::integer from public.user_activity_log where resource_id = 'e1210000-0000-4000-8000-000000000001'), 1, 'moderation creates an actor-bound audit event');
select lives_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000002', 'hide', 'Paused')$$,
 'an identical retry returns the committed resolution');
select is((select count(*)::integer from public.user_activity_log where resource_id = 'e1210000-0000-4000-8000-000000000001'), 1, 'retry does not duplicate audit events');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1210000-0000-4000-8000-000000000001","email":"moderation-owner@example.invalid","role":"authenticated"}', true);
select throws_ok($$update public.problem_sets set sharing_level = 'public' where id = 'c1210000-0000-4000-8000-000000000001'$$,
 '42501', 'sharing_paused_by_moderation', 'owner cannot republish a moderated set');
select throws_ok($$update public.problem_sets set moderation_status = 'visible' where id = 'c1210000-0000-4000-8000-000000000001'$$,
 '42501', 'protected_moderation_fields', 'owner cannot clear the moderation flag directly');
select is((select count(*)::integer from public.problems where id = 'd1210000-0000-4000-8000-000000000001'), 1, 'owner retains access to the original');
reset role;
select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000002', 'a1210000-0000-4000-8000-000000000002', 'hide', 'Second pause');
select lives_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000001', 'a1210000-0000-4000-8000-000000000002', 'restore', 'Restored')$$,
 'staff can reverse their resolution');
select is((select moderation_status from public.problem_sets where id = 'c1210000-0000-4000-8000-000000000001'), 'hidden', 'another active hide still prevents sharing');
select lives_ok($$select public.resolve_problem_set_report('e1210000-0000-4000-8000-000000000002', 'a1210000-0000-4000-8000-000000000002', 'restore', 'Restored again')$$,
 'last remaining hide can be reversed');
select ok((select sharing_level = 'public' and is_listed and moderation_status = 'visible' from public.problem_sets where id = 'c1210000-0000-4000-8000-000000000001'),
 'multiple hides preserve and restore the original visibility');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1210000-0000-4000-8000-000000000003","email":"moderation-reporter@example.invalid","role":"authenticated"}', true);
select is((select count(*)::integer from public.problem_set_reports), 1, 'reporter can read only their own feedback');
select is((select result_message from public.problem_set_reports where id = 'e1210000-0000-4000-8000-000000000001'), 'Restored', 'reporter receives the current resolution message');
reset role;
delete from public.problem_sets where id = 'c1210000-0000-4000-8000-000000000001';
select ok((select problem_set_id is null and target_title = 'Reported notebook' from public.problem_set_reports where id = 'e1210000-0000-4000-8000-000000000001'),
 'target deletion preserves report history and its title snapshot');
select is((select count(*)::integer from public.user_activity_log where resource_id = 'e1210000-0000-4000-8000-000000000001'), 2,
 'restoration remains an independently recorded audit action');
select * from finish();
rollback;
