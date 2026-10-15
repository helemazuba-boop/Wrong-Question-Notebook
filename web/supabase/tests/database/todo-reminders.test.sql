begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
insert into auth.users(id,email) values
('a1220000-0000-4000-8000-000000000001','reminder-a@example.invalid'),
('a1220000-0000-4000-8000-000000000002','reminder-b@example.invalid');
insert into public.todos(id,user_id,title,status,reminder_at) values
('b1220000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001','Due','pending',now()-interval '1 minute'),
('b1220000-0000-4000-8000-000000000002','a1220000-0000-4000-8000-000000000001','Completed','completed',now()-interval '1 minute'),
('b1220000-0000-4000-8000-000000000003','a1220000-0000-4000-8000-000000000002','Disabled','pending',now()-interval '1 minute');
update public.user_profiles set is_active=false where id='a1220000-0000-4000-8000-000000000002';
select lives_ok($$select public.register_push_subscription('a1220000-0000-4000-8000-000000000001','https://fcm.googleapis.com/fixture','key','auth','en')$$,'active user can register');
select throws_ok($$select public.register_push_subscription('a1220000-0000-4000-8000-000000000002','https://fcm.googleapis.com/fixture','key','auth','en')$$,'42501','account_inactive','disabled user cannot register');
select is(public.enqueue_todo_reminders(),1,'only the pending active todo is enqueued');
select is(public.enqueue_todo_reminders(),0,'the same schedule is delivered once');
select is((select count(*)::integer from public.todo_push_deliveries),1,'one push delivery per endpoint');
select is((select count(*)::integer from public.claim_todo_push_deliveries()),1,'first worker claims due delivery');
select is((select count(*)::integer from public.claim_todo_push_deliveries()),0,'second worker cannot claim an unexpired lease');
update public.todo_push_deliveries set lease_until=now()-interval '1 minute';
select is((select count(*)::integer from public.claim_todo_push_deliveries()),1,'expired lease is recoverable');
update public.todos set reminder_at=now()-interval '2 minutes' where id='b1220000-0000-4000-8000-000000000001';
select is(public.enqueue_todo_reminders(),1,'a changed reminder time has its own idempotency key');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1220000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::integer from public.todo_notifications),2,'owner can read reminder inbox');
select throws_ok($$update public.todo_notifications set title='spoof'$$,'42501',null,'owner cannot spoof reminder content');
reset role;
update public.user_profiles set is_active=true where id='a1220000-0000-4000-8000-000000000002';
select throws_ok($$select public.register_push_subscription('a1220000-0000-4000-8000-000000000002','https://fcm.googleapis.com/fixture','key','auth','en')$$,'42501','subscription_owner_conflict','endpoint ownership cannot be stolen');
select * from finish();
rollback;
