-- R-08: canonical receipt reads never acknowledge, skip or repair local facts.
begin;
create extension if not exists pgtap with schema extensions;
insert into auth.users (id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
 ('b8060000-0000-4000-8000-000000000001','authenticated','authenticated','receipt-owner@example.invalid','',now(),now(),'{}','{}'),
 ('b8060000-0000-4000-8000-000000000002','authenticated','authenticated','receipt-other@example.invalid','',now(),now(),'{}','{}');
insert into public.esp32_devices (id,user_id,mac_address,hardware_id,access_token_hash,firmware_version,last_protocol_version,protocol_capabilities) values
 ('b8060000-0000-4000-8000-000000000010','b8060000-0000-4000-8000-000000000001','B8:06:00:00:00:01','B8:06:00:00:00:01',repeat('1',64),'receipts-test','v3','[]'),
 ('b8060000-0000-4000-8000-000000000011','b8060000-0000-4000-8000-000000000001','B8:06:00:00:00:02','B8:06:00:00:00:02',repeat('2',64),'receipts-test','v3','[]'),
 ('b8060000-0000-4000-8000-000000000012','b8060000-0000-4000-8000-000000000002','B8:06:00:00:00:03','B8:06:00:00:00:03',repeat('3',64),'receipts-test','v3','[]');
update public.user_profiles set is_active=true where id in ('b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000002');
insert into public.study_sessions (id,user_id,device_id,domain,mode,purpose,ordering,scope,seed,candidate_items,candidate_count,create_request_id,create_fingerprint,next_sequence,status,expires_at) values
 ('b8060000-0000-4000-8000-000000000020','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','word','sequential','study','sequential','{"deck_ids":[],"include_mastered":true}','receipt-seed','[]',0,'receipt_session_00000000',repeat('a',64),8,'abandoned',now()-interval '1 day'),
 ('b8060000-0000-4000-8000-000000000021','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','word','sequential','study','sequential','{"deck_ids":[],"include_mastered":true}','receipt-seed','[]',0,'receipt_session_00000001',repeat('a',64),8,'abandoned',now()-interval '1 day'),
 ('b8060000-0000-4000-8000-000000000022','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','note','sequential','browse','sequential_note_v1','{"notebook_ids":[],"include_archived":false}','receipt-seed','[]',0,'receipt_session_00000002',repeat('a',64),8,'completed',now()-interval '1 day'),
 ('b8060000-0000-4000-8000-000000000023','b8060000-0000-4000-8000-000000000002','b8060000-0000-4000-8000-000000000012','word','sequential','study','sequential','{"deck_ids":[],"include_mastered":true}','receipt-seed','[]',0,'receipt_session_00000003',repeat('a',64),8,'abandoned',now()-interval '1 day'),
 ('b8060000-0000-4000-8000-000000000024','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000011','word','sequential','study','sequential','{"deck_ids":[],"include_mastered":true}','receipt-seed','[]',0,'receipt_session_00000004',repeat('a',64),8,'abandoned',now()-interval '1 day');
insert into public.study_observations (id,user_id,device_id,request_id,session_id,sequence,item_id,action,mode,occurred_at,result) values
 ('b8060000-0000-4000-8000-000000000100','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','receipt_word_original_01','b8060000-0000-4000-8000-000000000020',7,'b8060000-0000-4000-8000-000000000200','shown','sequential','2026-10-27T00:00:00Z','{}'),
 ('b8060000-0000-4000-8000-000000000101','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','receipt_other_session_01','b8060000-0000-4000-8000-000000000021',7,'b8060000-0000-4000-8000-000000000201','shown','sequential','2026-10-27T00:00:00Z','{}'),
 ('b8060000-0000-4000-8000-000000000102','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000010','receipt_note_original_01','b8060000-0000-4000-8000-000000000022',7,'b8060000-0000-4000-8000-000000000202','opened','sequential','2026-10-27T00:00:00Z','{}'),
 ('b8060000-0000-4000-8000-000000000103','b8060000-0000-4000-8000-000000000002','b8060000-0000-4000-8000-000000000012','receipt_other_user_0001','b8060000-0000-4000-8000-000000000023',7,'b8060000-0000-4000-8000-000000000203','shown','sequential','2026-10-27T00:00:00Z','{}'),
 ('b8060000-0000-4000-8000-000000000104','b8060000-0000-4000-8000-000000000001','b8060000-0000-4000-8000-000000000011','receipt_other_device_01','b8060000-0000-4000-8000-000000000024',7,'b8060000-0000-4000-8000-000000000204','shown','sequential','2026-10-27T00:00:00Z','{}');
create function pg_temp.receipts(p_sid uuid default 'b8060000-0000-4000-8000-000000000020',p_domain text default 'word',
 p_ids text[] default array['receipt_word_original_01','receipt_missing_00001','receipt_other_session_01'],
 p_user uuid default 'b8060000-0000-4000-8000-000000000001',p_device uuid default 'b8060000-0000-4000-8000-000000000010') returns jsonb language sql stable as $$
 select public.lookup_device_outbox_receipts_v1(p_user,p_device,p_domain,p_sid,p_ids);
$$;
-- Fingerprint all study rows and device metadata before any receipt call.
create temporary table receipt_before as select md5(concat(
 (select jsonb_agg(to_jsonb(s) order by s.id)::text from public.study_sessions s),
 (select jsonb_agg(to_jsonb(o) order by o.id)::text from public.study_observations o),
 (select jsonb_agg(to_jsonb(d) order by d.id)::text from public.esp32_devices d)
)) as digest;

select plan(32);
select is(pg_temp.receipts()->>'contract','outbox-reconciliation-v1','versioned receipt contract');

select is(pg_temp.receipts()#>>'{actor,user_id}','b8060000-0000-4000-8000-000000000001','actor bound to owner');

select is(pg_temp.receipts()#>>'{actor,device_id}','b8060000-0000-4000-8000-000000000010','actor bound to device');

select is(pg_temp.receipts()#>>'{receipts,0,state}','found','original request found');

select is(pg_temp.receipts()#>>'{receipts,0,observation,observation_id}','b8060000-0000-4000-8000-000000000100','canonical observation identity');

select is(pg_temp.receipts()#>>'{receipts,0,observation,sequence}','7','canonical sequence retained');

select is((pg_temp.receipts()#>>'{receipts,0,observation,occurred_at}')::timestamptz,'2026-10-27T00:00:00Z'::timestamptz,'original timestamp retained');

select is(pg_temp.receipts()#>>'{receipts,1,state}','not_found','next_sequence does not prove a missing request');

select is(pg_temp.receipts()#>>'{receipts,2,state}','conflict','ID consumed by another session is not missing');

select is(pg_temp.receipts()#>'{receipts,2,observation}','null'::jsonb,'conflict discloses no other-session payload');

select is(pg_temp.receipts()->>'repair_authorized','false','receipts cannot authorize repair');

select is(pg_temp.receipts(p_ids=>array['receipt_other_user_0001'])#>>'{receipts,0,state}','not_found','cross-user request not disclosed');

select is(pg_temp.receipts(p_ids=>array['receipt_other_device_01'])#>>'{receipts,0,state}','not_found','cross-device request not disclosed');

select is(pg_temp.receipts(p_sid=>'b8060000-0000-4000-8000-000000000023'),null::jsonb,'unowned session unavailable');

select is(pg_temp.receipts(p_device=>'b8060000-0000-4000-8000-000000000011'),null::jsonb,'other owned device cannot read this session');

select is(pg_temp.receipts(p_user=>'b8060000-0000-4000-8000-000000000002'),null::jsonb,'device and user pair must match');

select is(pg_temp.receipts(p_domain=>'note'),null::jsonb,'cross-domain session unavailable');

select is(pg_temp.receipts(p_sid=>'b8060000-0000-4000-8000-000000000999'),null::jsonb,'absent session same unavailable result');

select is(pg_temp.receipts(p_sid=>'b8060000-0000-4000-8000-000000000022',p_domain=>'note',p_ids=>array['receipt_note_original_01'])#>>'{receipts,0,observation,action}','opened','expired completed Note facts remain readable');

select is(pg_temp.receipts(p_ids=>array['receipt_missing_00001','receipt_word_original_01'])#>>'{receipts,0,request_id}','receipt_missing_00001','input order retained');

select throws_ok($$select pg_temp.receipts(p_ids=>array[]::text[])$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','empty query rejected');

select throws_ok($$select pg_temp.receipts(p_ids=>array['receipt_word_original_01','receipt_word_original_01'])$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','duplicate query IDs rejected');

select throws_ok($$select pg_temp.receipts(p_ids=>array[null]::text[])$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','null query ID rejected');

select throws_ok($$select pg_temp.receipts(p_ids=>array['invalid/request_0001'])$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','unsafe query ID rejected');

select throws_ok($$select pg_temp.receipts(p_ids=>(select array_agg('receipt_query_id_'||lpad(n::text,3,'0')) from generate_series(1,65) n))$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','65 queries rejected');

select throws_ok($$select pg_temp.receipts(p_ids=>array[['receipt_word_original_01','receipt_missing_00001']])$$,'22023','INVALID_OUTBOX_RECEIPT_QUERY','multidimensional query rejected');

select ok(not has_function_privilege('anon','public.lookup_device_outbox_receipts_v1(uuid,uuid,text,uuid,text[])','execute'),'anon denied');

select ok(not has_function_privilege('authenticated','public.lookup_device_outbox_receipts_v1(uuid,uuid,text,uuid,text[])','execute'),'ordinary authenticated role denied');

select ok(has_function_privilege('service_role','public.lookup_device_outbox_receipts_v1(uuid,uuid,text,uuid,text[])','execute'),'service role can invoke');

select is((select provolatile::text from pg_proc where oid='public.lookup_device_outbox_receipts_v1(uuid,uuid,text,uuid,text[])'::regprocedure),'s','STABLE read-only execution');

update public.user_profiles set is_active=false where id='b8060000-0000-4000-8000-000000000001';
select is(pg_temp.receipts(),null::jsonb,'disabled account not exposed');
update public.user_profiles set is_active=true where id='b8060000-0000-4000-8000-000000000001';

select is(md5(concat((select jsonb_agg(to_jsonb(s) order by s.id)::text from public.study_sessions s),(select jsonb_agg(to_jsonb(o) order by o.id)::text from public.study_observations o),(select jsonb_agg(to_jsonb(d) order by d.id)::text from public.esp32_devices d))), (select digest from receipt_before),'all study rows and device metadata unchanged');

select * from finish();
rollback;
