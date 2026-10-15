begin;
select no_plan();
insert into auth.users(id,email) values('e1420000-0000-4000-8000-000000000001','voice-owner@example.test'),('e1420000-0000-4000-8000-000000000002','voice-other@example.test');
insert into public.esp32_devices(id,user_id,mac_address,access_token_hash) values('e1420000-0000-4000-8000-000000000003','e1420000-0000-4000-8000-000000000001','EE:14:20:00:00:01',repeat('f',64));
insert into public.subjects(id,user_id,name) values('e1420000-0000-4000-8000-000000000004','e1420000-0000-4000-8000-000000000001','Voice');
insert into public.notebooks(id,user_id,subject_id,title) values('e1420000-0000-4000-8000-000000000005','e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000004','Voice Notes');
insert into public.notebook_ai_access(user_id,notebook_id,can_create) values('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000005',true);
create temp table voice_ops(label text primary key,op jsonb);
create function pg_temp.voice_prepare(p_tool text,p_request text,p_args jsonb,p_command jsonb) returns jsonb language plpgsql as $$declare v jsonb;begin
v:=public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003',p_tool,p_request,repeat('a',64),p_args);
return public.prepare_mcp_operation_v2('e1420000-0000-4000-8000-000000000001',(v->>'id')::uuid,(v->>'lease_token')::uuid,p_command);
end$$;
insert into voice_ops values('todo',pg_temp.voice_prepare('create_todo','voice_todo_req_01','{"title":"明天复习","due":{"date":"tomorrow"}}',
'{"kind":"insert","table":"todos","time_context":{"now":"2026-10-14T16:30:00Z","timezone":"Asia/Shanghai"},"row":{"id":"e1420000-0000-4000-8000-000000000010","user_id":"e1420000-0000-4000-8000-000000000001","source_device_id":"e1420000-0000-4000-8000-000000000003","title":"明天复习","source":"ai","created_by":"ai","due_at":"2026-10-16T15:59:59Z"}}'));
select ok(not(public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003','create_todo','voice_todo_req_01',repeat('a',64),'{}')->>'claimed')::boolean,'another claimant cannot execute a live voice operation');
select throws_ok($$select public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003','create_todo','voice_todo_req_01',repeat('b',64),'{}')$$,'22023','request_id_reused','changed voice arguments do not replay');
update voice_ops set op=public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,(op->>'lease_token')::uuid) where label='todo';
select is(op->>'state','committed','voice Todo and its receipt commit together') from voice_ops where label='todo';
select is((select count(*)::int from public.todos where id='e1420000-0000-4000-8000-000000000010'),1,'one Todo saved');
select is(op->'receipt'->'row'->>'due_at','2026-10-16T15:59:59+00:00','resolved date is durable in receipt') from voice_ops where label='todo';
select is((select reminder_at from public.todos where id='e1420000-0000-4000-8000-000000000010'),null::timestamptz,'date arrangement does not invent a reminder');
update public.mcp_v2_operations set recover_until=now()-interval '1 day' where id=(select (op->>'id')::uuid from voice_ops where label='todo');
select ok((public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,null)->>'replayed')::boolean,'committed voice receipt replays after TTL') from voice_ops where label='todo';
select is((select count(*)::int from public.todos where id='e1420000-0000-4000-8000-000000000010'),1,'retry creates no second Todo');
select throws_ok($$select public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000002','e1420000-0000-4000-8000-000000000003','create_todo','voice_other_req01',repeat('a',64),'{}')$$,'42501','device_context_mismatch','user/device mismatch rejected');
select throws_ok($$select public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003','add_word_entry','voice_word_req_01',repeat('a',64),'{}')$$,'42501','voice_write_not_allowed','Word mutation cannot enter voice operation path');
select throws_ok($$select public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003','update_notebook_note','voice_edit_req_01',repeat('a',64),'{}')$$,'42501','voice_write_not_allowed','existing content updates not allowed');
select ok(not has_function_privilege('authenticated','public.begin_mcp_voice_operation_v1(uuid,uuid,text,text,text,jsonb)','EXECUTE'),'cookie client cannot impersonate a device');
select ok(not has_function_privilege('anon','public.commit_mcp_voice_operation_v1(uuid,uuid,uuid)','EXECUTE'),'anonymous client cannot commit voice effects');

insert into voice_ops values('note',pg_temp.voice_prepare('create_notebook_note','voice_note_req_01','{"notebook_id":"e1420000-0000-4000-8000-000000000005"}',
'{"kind":"insert","table":"notebook_notes","row":{"id":"e1420000-0000-4000-8000-000000000011","user_id":"e1420000-0000-4000-8000-000000000001","notebook_id":"e1420000-0000-4000-8000-000000000005","title":"New Note","content":"text","source":"ai","client_request_id":"voice_note_req_01"}}'));
update voice_ops set op=public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,(op->>'lease_token')::uuid) where label='note';
select is(op->>'state','committed','Note creation uses the same atomic receipt') from voice_ops where label='note';
select ok((public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,null)->>'replayed')::boolean,'lost Note response replays') from voice_ops where label='note';
select is((select count(*)::int from public.notebook_notes where id='e1420000-0000-4000-8000-000000000011'),1,'Note replay creates no duplicate');
update public.notebook_ai_access set can_create=false where notebook_id='e1420000-0000-4000-8000-000000000005';
select throws_ok(format('select public.commit_mcp_voice_operation_v1(%L,%L,null)','e1420000-0000-4000-8000-000000000001',(select op->>'id' from voice_ops where label='note')),'42501','notebook_permission_denied','revoked permission applies even when returning a Note receipt');

create function pg_temp.reject_voice_todo() returns trigger language plpgsql as $$begin if new.id='e1420000-0000-4000-8000-000000000012' then raise exception 'voice_write_fault';end if;return new;end$$;
create trigger voice_write_fault after insert on public.todos for each row execute function pg_temp.reject_voice_todo();
insert into voice_ops values('fault',pg_temp.voice_prepare('create_todo','voice_fault_req01','{}',
'{"kind":"insert","table":"todos","row":{"id":"e1420000-0000-4000-8000-000000000012","user_id":"e1420000-0000-4000-8000-000000000001","source_device_id":"e1420000-0000-4000-8000-000000000003","title":"Must roll back"}}'));
update voice_ops set op=public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,(op->>'lease_token')::uuid) where label='fault';
select is(op->>'state','failed','injected business fault reports uncommitted failure') from voice_ops where label='fault';
select is((select count(*)::int from public.todos where id='e1420000-0000-4000-8000-000000000012'),0,'injected fault rolls back business row');
select is(op->>'receipt',null::text,'failed operation has no success receipt') from voice_ops where label='fault';
drop trigger voice_write_fault on public.todos;
insert into voice_ops values('status',pg_temp.voice_prepare('update_todo_status','voice_status_req1','{"todo_id":"e1420000-0000-4000-8000-000000000010","status":"completed"}','{"kind":"todo_status"}'));
update voice_ops set op=public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,(op->>'lease_token')::uuid) where label='status';
select is(op->>'state','committed','Todo status is a direct atomic action') from voice_ops where label='status';
select is((select status from public.todos where id='e1420000-0000-4000-8000-000000000010'),'completed','completion saved');
select ok((public.commit_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001',(op->>'id')::uuid,null)->>'replayed')::boolean,'status retry replays without resetting completion timestamp') from voice_ops where label='status';
update public.user_profiles set is_active=false where id='e1420000-0000-4000-8000-000000000001';
select throws_ok($$select public.begin_mcp_voice_operation_v1('e1420000-0000-4000-8000-000000000001','e1420000-0000-4000-8000-000000000003','create_todo','voice_block_req01',repeat('a',64),'{}')$$,'42501','device_context_mismatch','disabled account cannot begin a voice write');
select * from finish();
rollback;
