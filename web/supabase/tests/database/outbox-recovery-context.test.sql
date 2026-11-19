begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
 ('b8150000-0000-4000-8000-000000000001','authenticated','authenticated','history-owner@example.invalid','',now(),now(),'{}','{}'),
 ('b8150000-0000-4000-8000-000000000002','authenticated','authenticated','history-other@example.invalid','',now(),now(),'{}','{}');
update public.user_profiles set is_active=true where id in
 ('b8150000-0000-4000-8000-000000000001','b8150000-0000-4000-8000-000000000002');

insert into public.esp32_devices (id,user_id,mac_address,hardware_id,access_token_hash,firmware_version,last_protocol_version,protocol_capabilities) values
 ('b8150000-0000-4000-8000-000000000010','b8150000-0000-4000-8000-000000000001','B8:15:00:00:00:01','B8:15:00:00:00:01',repeat('1',64),'history-test','v3','[]'),
 ('b8150000-0000-4000-8000-000000000011','b8150000-0000-4000-8000-000000000001','B8:15:00:00:00:02','B8:15:00:00:00:02',repeat('2',64),'history-test','v3','[]');
insert into public.word_decks (id,user_id,title,source,is_system)
 select ('b8150000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
   'b8150000-0000-4000-8000-000000000001','History deck '||n,'user',false from generate_series(1,32) n;
insert into public.word_packs (deck_id,revision,schema_version,format,compression,storage_path,sha256,byte_size,entry_count,status)
 values ('b8150000-0000-4000-8000-000000000132',7,2,'jsonl','none','history/ready',repeat('7',64),100,500,'ready'),
        ('b8150000-0000-4000-8000-000000000132',8,2,'jsonl','none','history/current',repeat('8',64),100,500,'ready'),
        ('b8150000-0000-4000-8000-000000000131',7,2,'jsonl','none','history/stale',repeat('7',64),100,0,'stale');
insert into public.device_pack_artifacts (user_id,domain,logical_id,revision,sha256,storage_path,byte_size)
 values ('b8150000-0000-4000-8000-000000000001','note_packs','b8150000-0000-4000-8000-000000000080',9,repeat('9',64),'history/note',199),
        ('b8150000-0000-4000-8000-000000000002','note_packs','b8150000-0000-4000-8000-000000000081',9,repeat('9',64),'history/foreign',199);

insert into public.study_sessions (
  id,user_id,device_id,domain,mode,purpose,ordering,scope,seed,snapshot,candidate_items,candidate_count,
  optional_count,progress_revision,create_request_id,create_fingerprint,next_sequence,status,expires_at,
  local_session,local_start_index,local_fingerprint
)
select 'b8150000-0000-4000-8000-000000000020','b8150000-0000-4000-8000-000000000001',
  'b8150000-0000-4000-8000-000000000010','word','shuffle','study','pure_random_v1',
  jsonb_build_object('deck_ids',(select jsonb_agg('b8150000-0000-4000-8000-'||lpad((100+n)::text,12,'0') order by n desc) from generate_series(1,32) n),'include_mastered',false),
  'b8150000-0000-4000-8000-000000000090',
  (select jsonb_agg(jsonb_build_object('deck_id','b8150000-0000-4000-8000-'||lpad((100+n)::text,12,'0'),'pack_revision',7,'content_revision',42,'sha256',repeat('7',64)) order by n desc) from generate_series(1,32) n),
  (select jsonb_agg(jsonb_build_object('item_id','AB150000-0000-4000-8000-'||lpad(n::text,12,'0'),'deck_id','b8150000-0000-4000-8000-000000000132','ordinal',n) order by n) from generate_series(0,499) n),
  500,500,17,'history_session_00000001',repeat('a',64),2,'completed',now()-interval '1 day',true,500,repeat('b',64);

insert into public.study_sessions (
  id,user_id,device_id,domain,mode,purpose,ordering,scope,seed,snapshot,candidate_items,candidate_count,
  optional_count,create_request_id,create_fingerprint,status,expires_at
) values (
  'b8150000-0000-4000-8000-000000000021','b8150000-0000-4000-8000-000000000001',
  'b8150000-0000-4000-8000-000000000010','note','recent','browse','least_recently_viewed_v1',
  '{"notebook_ids":["b8150000-0000-4000-8000-000000000080","b8150000-0000-4000-8000-000000000081"],"include_archived":false}','old-note',
  jsonb_build_array(jsonb_build_object('notebook_id','b8150000-0000-4000-8000-000000000080','content_revision',19,'pack_revision',9,'sha256',repeat('9',64)),
    jsonb_build_object('notebook_id','b8150000-0000-4000-8000-000000000081','content_revision',20,'pack_revision',9,'sha256',repeat('9',64))),
  '[{"item_id":"ab150000-0000-4000-8000-000000000001","notebook_id":"b8150000-0000-4000-8000-000000000080","ordinal":0,"last_opened_at":"2025-01-01T00:00:00Z"}]',
  1,null,'history_session_00000002',repeat('a',64),'abandoned',now()-interval '1 day'
);
insert into public.study_observations (user_id,device_id,request_id,session_id,sequence,item_id,action,mode,occurred_at,result) values
 ('b8150000-0000-4000-8000-000000000001','b8150000-0000-4000-8000-000000000010','history_accepted_000001','b8150000-0000-4000-8000-000000000020',0,'ab150000-0000-4000-8000-000000000000','shown','shuffle','2026-10-28T00:00:00Z','{}'),
 ('b8150000-0000-4000-8000-000000000001','b8150000-0000-4000-8000-000000000010','history_conflict_000001','b8150000-0000-4000-8000-000000000021',0,'ab150000-0000-4000-8000-000000000001','opened','recent','2026-10-28T00:00:00Z','{}');

create function pg_temp.ctx(
  part text default 'session', off integer default 0, sha text default null,
  domain text default 'word', sid uuid default 'b8150000-0000-4000-8000-000000000020',
  mac text default 'b81500000001', token text default repeat('1',64),
  ids text[] default array[]::text[], nonce text default repeat('a',32),
  uid uuid default 'b8150000-0000-4000-8000-000000000001',
  device uuid default 'b8150000-0000-4000-8000-000000000010',
  manifest text default repeat('b',64), elf text default repeat('c',64)
) returns jsonb language sql stable as $$
  select public.read_device_outbox_recovery_context_v1(uid,device,domain,sid,mac,nonce,manifest,elf,part,off,sha,token,ids);
$$;
create function pg_temp.word_sha() returns text language sql stable as $$
  select pg_temp.ctx()->>'context_sha256';
$$;
create function pg_temp.note_ctx(part text default 'session', sha text default null) returns jsonb language sql stable as $$
  select pg_temp.ctx(part=>part,sha=>sha,domain=>'note',sid=>'b8150000-0000-4000-8000-000000000021');
$$;
create function pg_temp.snapshot_hash() returns text language sql stable as $$
  select md5(concat(
    (select jsonb_agg(to_jsonb(s) order by id) from public.study_sessions s),
    (select jsonb_agg(to_jsonb(o) order by id) from public.study_observations o),
    (select jsonb_agg(to_jsonb(d) order by id) from public.esp32_devices d),
    (select jsonb_agg(to_jsonb(w) order by id) from public.word_packs w)
  ));
$$;
create temp table before_read as select pg_temp.snapshot_hash() as digest;
select is(pg_temp.ctx()->>'contract','outbox-recovery-context-v1','versioned read context');
select is(pg_temp.ctx()#>>'{session,status}','completed','expired completed history readable');
select is(pg_temp.ctx()#>>'{session,local_start_index}','500','local start marker retained');
select is(pg_temp.ctx()#>>'{session,local_fingerprint}',repeat('b',64),'local registration fingerprint retained');
select is(pg_temp.ctx()#>>'{session,progress_revision}','17','historical progress revision retained');
select is(pg_temp.ctx()#>>'{session,scope,deck_ids,0}','b8150000-0000-4000-8000-000000000132','declared scope order retained');
select is(pg_temp.ctx()#>>'{binding,source_mac}','b81500000001','normalized verified source MAC');
select is(pg_temp.ctx()#>>'{binding,manifest_sha256}',repeat('b',64),'manifest challenge echoed');
select is(pg_temp.ctx()->>'repair_authorized','false','read grants no repair authority');
select ok(pg_temp.word_sha() ~ '^[0-9a-f]{64}$','bounded context identity');
select is(pg_temp.ctx('pins',0,pg_temp.word_sha())#>>'{pins,0,registry,record,pack_revision}','7','exact historical Word revision, not the latest');
select is(pg_temp.ctx('pins',0,pg_temp.word_sha())#>>'{pins,0,registry,state}','ready','READY row observed');
select is(pg_temp.ctx('pins',0,pg_temp.word_sha())#>>'{pins,1,registry,state}','stale','stale row remains distinguishable');
select is(pg_temp.ctx('pins',0,pg_temp.word_sha())#>>'{pins,2,registry,state}','missing','missing row remains explicit');
select is(pg_temp.ctx('pins',0,pg_temp.word_sha())#>>'{pins,0,pin,content_revision}','42','declared revision retained separately');
select ok(not (pg_temp.ctx('pins',0,pg_temp.word_sha())#>'{pins,0,registry,record}' ? 'content_revision'),'registry does not invent historical content revision');
select is(jsonb_array_length(pg_temp.ctx('pins',0,pg_temp.word_sha())->'pins'),8,'pin page cap');
select is(pg_temp.ctx('pins',24,pg_temp.word_sha())#>>'{pins,7,index}','31','all 32 pins paged in order');
select is(jsonb_array_length(pg_temp.ctx('candidates',0,pg_temp.word_sha())->'candidates'),32,'candidate page cap');
select is(pg_temp.ctx('candidates',0,pg_temp.word_sha())#>>'{candidates,0,item,item_id}','AB150000-0000-4000-8000-000000000000','historical candidate UUID byte case retained');
select is(pg_temp.ctx('candidates',480,pg_temp.word_sha())#>>'{candidates,19,item,ordinal}','499','all 500 candidates paged in order');
select is(pg_temp.ctx('candidates',480,pg_temp.word_sha())->>'has_more','false','candidate terminal page');
select is(pg_temp.ctx('candidates',500,pg_temp.word_sha())->'candidates','[]'::jsonb,'explicit empty page at end');
select throws_ok($$select pg_temp.ctx('pins',33,pg_temp.word_sha())$$,'22023','INVALID_OUTBOX_RECOVERY_CONTEXT_OFFSET','past end refused');
select throws_ok($$select pg_temp.ctx('pins')$$,'22023','INVALID_OUTBOX_RECOVERY_CONTEXT_QUERY','follow-up pages require context pin');
select throws_ok($$select pg_temp.ctx('pins',0,pg_temp.word_sha(),nonce=>repeat('d',32))$$,'40001','OUTBOX_RECOVERY_CONTEXT_CHANGED','nonce drift invalidates page');
select throws_ok($$select pg_temp.ctx('pins',0,pg_temp.word_sha(),manifest=>repeat('d',64))$$,'40001','OUTBOX_RECOVERY_CONTEXT_CHANGED','manifest drift invalidates page');
select throws_ok($$select pg_temp.ctx('pins',0,pg_temp.word_sha(),elf=>repeat('d',64))$$,'40001','OUTBOX_RECOVERY_CONTEXT_CHANGED','ELF drift invalidates page');
select is(pg_temp.ctx(mac=>'b81500000002'),null::jsonb,'wrong MAC unavailable');
select is(pg_temp.ctx(token=>repeat('3',64)),null::jsonb,'rotated credential unavailable');
select is(pg_temp.ctx(uid=>'b8150000-0000-4000-8000-000000000002'),null::jsonb,'wrong owner unavailable');
select is(pg_temp.ctx(device=>'b8150000-0000-4000-8000-000000000011',mac=>'b81500000002',token=>repeat('2',64)),null::jsonb,'other same-account device unavailable');
select is(pg_temp.ctx(domain=>'note'),null::jsonb,'wrong domain unavailable');
select is(pg_temp.ctx(sid=>'b8150000-0000-4000-8000-000000000099'),null::jsonb,'absent context unavailable');
select is(pg_temp.note_ctx()#>>'{session,status}','abandoned','expired Note context readable');
select is(pg_temp.note_ctx('pins',pg_temp.note_ctx()->>'context_sha256')#>>'{pins,0,registry,state}','found','own Note artifact observed');
select is(pg_temp.note_ctx('pins',pg_temp.note_ctx()->>'context_sha256')#>>'{pins,1,registry,state}','missing','other-owner Note artifact unavailable');
select is(pg_temp.note_ctx('candidates',pg_temp.note_ctx()->>'context_sha256')#>>'{candidates,0,item,last_opened_at}','2025-01-01T00:00:00Z','retained Note candidate pin');

create temp table receipt_example as select pg_temp.ctx('receipts',0,pg_temp.word_sha(),ids=>array[
   'history_accepted_000001','history_missing_000001','history_conflict_000001']) as page;
select is(page#>>'{receipts,0,state}','found','historically accepted receipt found') from receipt_example;
select is(page#>>'{receipts,1,state}','not_found','missing receipt remains missing') from receipt_example;
select is(page#>>'{receipts,2,state}','conflict','cross-session consumed request remains conflict') from receipt_example;
select is(page#>'{receipts,2,observation}','null'::jsonb,'conflict reveals no other-session payload') from receipt_example;
select is(page->>'context_sha256',pg_temp.word_sha(),'receipts share selected context identity') from receipt_example;
-- Emit actual database-origin pages for the shared contract consumers. These
-- are synthetic fixtures created in this rollback-only transaction.
select 'WIRE ' || pg_temp.ctx()::text;
select 'WIRE ' || pg_temp.ctx('pins',n,pg_temp.word_sha())::text from generate_series(0,24,8) n;
select 'WIRE ' || pg_temp.ctx('candidates',n,pg_temp.word_sha())::text from generate_series(0,480,32) n;
select 'WIRE ' || page::text from receipt_example;
select 'WIRE ' || pg_temp.note_ctx()::text;
select 'WIRE ' || pg_temp.note_ctx('pins',pg_temp.note_ctx()->>'context_sha256')::text;
select 'WIRE ' || pg_temp.note_ctx('candidates',pg_temp.note_ctx()->>'context_sha256')::text;
select is(pg_temp.snapshot_hash(),digest,'read leaves sessions, facts, device and registry unchanged') from before_read;
select ok(not has_function_privilege('anon','public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])','execute'),'anon denied');
select ok(not has_function_privilege('authenticated','public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])','execute'),'authenticated denied');
select ok(has_function_privilege('service_role','public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])','execute'),'service role allowed');
select is(provolatile::text,'s','STABLE read snapshot') from pg_proc where oid='public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])'::regprocedure;

create temp table prior_context as select pg_temp.word_sha() as sha;
update public.word_packs set status='stale' where deck_id='b8150000-0000-4000-8000-000000000132' and revision=7;
select throws_ok($$select pg_temp.ctx('candidates',0,(select sha from prior_context))$$,'40001','OUTBOX_RECOVERY_CONTEXT_CHANGED','registry drift invalidates even candidate page');
update prior_context set sha=pg_temp.word_sha();
update public.study_sessions set next_sequence=3 where id='b8150000-0000-4000-8000-000000000020';
select throws_ok($$select pg_temp.ctx('pins',0,(select sha from prior_context))$$,'40001','OUTBOX_RECOVERY_CONTEXT_CHANGED','session drift invalidates even pin page');
update public.user_profiles set is_active=false where id='b8150000-0000-4000-8000-000000000001';
select is(pg_temp.ctx(),null::jsonb,'inactive account unavailable inside the same read');
select * from finish();
rollback;
