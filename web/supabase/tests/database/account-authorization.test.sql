begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
('a1200000-0000-4000-8000-000000000001', 'account-owner@example.invalid'),
('a1200000-0000-4000-8000-000000000002', 'account-reader@example.invalid');
insert into public.subjects (id, user_id, name) values
('b1200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000001', 'Account fixture');
insert into public.problem_sets (id, user_id, subject_id, name, sharing_level) values
('c1200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000001',
 'b1200000-0000-4000-8000-000000000001', 'Limited fixture', 'limited');

select ok(not has_table_privilege('authenticated', 'public.user_profiles', 'UPDATE'),
 'ordinary sessions have no blanket profile UPDATE');
select ok(has_column_privilege('authenticated', 'public.user_profiles', 'bio', 'UPDATE'),
 'ordinary profile editing remains available');
select ok(not has_column_privilege('authenticated', 'public.user_profiles', 'user_role', 'UPDATE'),
 'roles cannot be changed directly through PostgREST');
select ok(not has_column_privilege('authenticated', 'public.user_profiles', 'is_active', 'UPDATE'),
 'disabled users cannot reactivate themselves');
select ok(not has_table_privilege('authenticated', 'public.user_profiles', 'INSERT'),
 'profile INSERT/upsert cannot introduce a privileged account');
select ok(not has_function_privilege('authenticated', 'public.bootstrap_super_admin(uuid)', 'EXECUTE'),
 'initial administrator bootstrap is service-only');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1200000-0000-4000-8000-000000000002","email":"account-reader@example.invalid","role":"authenticated"}', true);
select is((select count(*)::integer from public.problem_sets where id = 'c1200000-0000-4000-8000-000000000001'), 0,
 'signed-in user without a limited grant cannot read set metadata');
select ok(public.is_account_active(), 'active JWT holder passes current account status');
reset role;

insert into public.problem_set_shares (problem_set_id, shared_with_email, shared_by_user_id)
values ('c1200000-0000-4000-8000-000000000001', 'account-reader@example.invalid', 'a1200000-0000-4000-8000-000000000001');
set local role authenticated;
select is((select count(*)::integer from public.problem_sets where id = 'c1200000-0000-4000-8000-000000000001'), 1,
 'limited grant restores authorized reads without an RLS recursion');
reset role;
update public.user_profiles set is_active = false where id = 'a1200000-0000-4000-8000-000000000002';
set local role authenticated;
select ok(not public.is_account_active(), 'old valid JWT is denied after account deactivation');
select throws_ok($$select public.get_subjects_with_metadata()$$, '42501', 'Account is disabled',
 'inactive accounts cannot bypass table policies through a definer RPC');
select is((select count(*)::integer from public.problem_sets where id = 'c1200000-0000-4000-8000-000000000001'), 0,
 'direct database reads obey account disablement even with a grant');
select lives_ok($$update public.user_profiles set bio = 'should not change' where id = 'a1200000-0000-4000-8000-000000000002'$$,
 'RLS filters inactive profile writes without exposing another account');
reset role;
select isnt((select bio from public.user_profiles where id = 'a1200000-0000-4000-8000-000000000002'),
 'should not change', 'inactive profile write did not modify the row');
select * from finish();
rollback;
