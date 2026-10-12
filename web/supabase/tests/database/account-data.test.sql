begin;
create extension if not exists pgtap with schema extensions;
select plan(10);
insert into auth.users(id,email) values
('a1230000-0000-4000-8000-000000000001','account-a@example.invalid'),
('a1230000-0000-4000-8000-000000000002','account-b@example.invalid');
insert into public.todos(user_id,title) select 'a1230000-0000-4000-8000-000000000001','Task '||n from generate_series(1,1001) n;
insert into public.todos(user_id,title) values('a1230000-0000-4000-8000-000000000002','Other account');
select is(jsonb_array_length(public.export_account_data('a1230000-0000-4000-8000-000000000001')->'todos'),1001,'account export is not truncated by a normal 1000-row API limit');
select ok(not public.export_account_data('a1230000-0000-4000-8000-000000000001') ? 'oauth_tokens','OAuth credential hashes are excluded');
select throws_ok($$select public.enqueue_account_data_job('a1230000-0000-4000-8000-000000000002','a1230000-0000-4000-8000-000000000001','delete')$$,'42501','permission_denied','ordinary user cannot request another account deletion');
select public.enqueue_account_data_job('a1230000-0000-4000-8000-000000000001','a1230000-0000-4000-8000-000000000001','export');
select is((select count(*)::integer from public.account_data_jobs where user_id='a1230000-0000-4000-8000-000000000001'),1,'export is durably queued');
select public.enqueue_account_data_job('a1230000-0000-4000-8000-000000000001','a1230000-0000-4000-8000-000000000001','export');
select is((select count(*)::integer from public.account_data_jobs where user_id='a1230000-0000-4000-8000-000000000001'),1,'retry does not create another active job');
select is((select count(*)::integer from public.claim_account_data_job()),1,'a worker claims the job');
select is((select count(*)::integer from public.claim_account_data_job()),0,'an active lease excludes a second worker');
update public.account_data_jobs set status='completed' where user_id='a1230000-0000-4000-8000-000000000001';
select public.enqueue_account_data_job('a1230000-0000-4000-8000-000000000001','a1230000-0000-4000-8000-000000000001','delete');
select is((select is_active from public.user_profiles where id='a1230000-0000-4000-8000-000000000001'),false,'deletion immediately disables the account');
select throws_ok($$select public.export_account_data('a1230000-0000-4000-8000-000000000001')$$,'42501','account_inactive','disabled account cannot start an export');
select is(public.replace_asset_reference('[{"path":"old","label":"untouched"}]','old','new'),'[{"path":"new","label":"untouched"}]'::jsonb,'attachment rewrite only replaces matching values');
select * from finish();rollback;
