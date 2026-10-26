begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(32);

create temporary table agent_test_artifact(value text);
insert into agent_test_artifact values ('{"schema_version":1,"subjects":[{"stable_key":"physics","name":"物理","aliases":[],"status":"active"}],"marks":[{"stable_key":"physics.knowledge.kinematics","name":"运动学","kind":"knowledge","subject":"physics","aliases":[],"include":[],"exclude":[],"status":"active"},{"stable_key":"physics.skill.motion","name":"运动公式","kind":"skill","subject":"physics","aliases":[],"include":[],"exclude":[],"status":"active"}]}');
-- A clean migration database may already contain canonical Subjects. Include all
-- existing identities when building the isolated fixture revision.
update agent_test_artifact set value=(jsonb_set(value::jsonb,'{subjects}',(
  select jsonb_agg(x order by x->>'stable_key') from (
    select jsonb_build_object('stable_key',s.stable_key,'name',s.name,'aliases',to_jsonb(s.aliases),'status',s.status) x from public.canonical_subjects s
    union all select '{"stable_key":"physics","name":"物理","aliases":[],"status":"active"}'::jsonb where not exists(select 1 from public.canonical_subjects where stable_key='physics')
  ) subjects
)))::text;
select public.sync_knowledge_registry_revision('https://example.invalid/agent-test',repeat('a',40),1,encode(extensions.digest(value,'sha256'),'hex'),value) from agent_test_artifact;
insert into auth.users(id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('a2500000-0000-4000-8000-000000000001','authenticated','authenticated','agent-mark-test@example.invalid','','{}','{}',now(),now());
insert into public.subjects(id,user_id,name,color,icon,canonical_subject_key) values('b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000001','物理','blue','Atom','physics');
insert into public.problems(id,user_id,subject_id,title,content,assets,solution_assets,status,parts,source,is_optional)
values('c2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000001','b2500000-0000-4000-8000-000000000001','Agent fixture','已知三个物理量','[]','[]','needs_review','[{"index":1,"type":"short_answer","content":"求第四个物理量"}]','{}',false);
create temporary table agent_test_tasks(value jsonb);
insert into agent_test_tasks select public.agent_mark_control_v1('claim',jsonb_build_object('worker_id','worker-one','registry_source_sha',repeat('a',40),'registry_content_sha256',encode(extensions.digest(value,'sha256'),'hex'),'bundle_sha256',repeat('b',64),'skill_version','1.0.0')) from agent_test_artifact;
select ok(not has_function_privilege('authenticated','public.agent_mark_control_v1(text,jsonb)','EXECUTE'),'public MCP credentials cannot execute internal task control');
select is((select value->>'state' from agent_test_tasks),'processing','claim creates a live task');
select is((select executor from public.problem_mark_annotation_runs where id=(select (value->>'run_id')::uuid from agent_test_tasks)),'agent','run records its actual executor');
select ok((select embedding_profile_id is null from public.problem_mark_annotation_runs where id=(select (value->>'run_id')::uuid from agent_test_tasks)),'Agent does not fabricate embedding provenance');
select isnt(public.agent_mark_control_v1('renew',jsonb_build_object('run_id',value->>'run_id','worker_id','worker-one'))->>'lease_token',value->>'lease_token','renewal rotates the annotation ownership token') from agent_test_tasks;
select lives_ok($q$select public.agent_mark_control_v1('bind',jsonb_build_object('run_id',value->>'run_id','worker_id','worker-one','session_id','ses_agent_fixture')) from agent_test_tasks$q$,'bind a single session before submitting upstream input');
select throws_ok($q$select public.agent_mark_control_v1('bind',jsonb_build_object('run_id',value->>'run_id','worker_id','worker-one','session_id','ses_another')) from agent_test_tasks$q$,'P0001','MARK_SESSION_CONFLICT','a task cannot be rebound to a second session');
insert into public.problem_marks(problem_id,mark_key,role,part_index,registry_revision_id,semantic_revision,source,is_user_override)
select 'c2500000-0000-4000-8000-000000000001','physics.knowledge.kinematics','target',null,(value->>'registry_revision_id')::bigint,(value->>'semantic_revision')::bigint,'user',true from agent_test_tasks;
create temporary table agent_test_result(value jsonb);
insert into agent_test_result values('{"assignments":[{"mark_key":"physics.knowledge.kinematics","role":"required","part_index":null,"evidence":{}}],"methods":[{"mark_key":"physics.skill.motion","preference":"recommended","part_index":1,"evidence":{"problem_quote":"求第四个物理量","document_quote":"运动公式","rationale":"fixture"}}],"unresolved":[]}');
select lives_ok($q$select public.agent_mark_control_v1('submit',jsonb_build_object('run_id',t.value->>'run_id','result',r.value,'fingerprint',repeat('c',64))) from agent_test_tasks t cross join agent_test_result r$q$,'atomic Agent submission succeeds');
select is((select receipt->>'accepted' from public.problem_mark_agent_tasks where run_id=(select (value->>'run_id')::uuid from agent_test_tasks)),'true','durable acceptance receipt exists');
select is(jsonb_array_length(public.get_problem_semantics('c2500000-0000-4000-8000-000000000001')->'methods'->'recommended'),1,'method preference is visible through the existing semantic reader');
select is((select count(*)::integer from public.problem_marks where mark_key='physics.skill.motion'),0,'recommended method does not become a required skill');
select is((select role from public.problem_marks where problem_id='c2500000-0000-4000-8000-000000000001' and is_user_override),'target','Agent preserves a user correction');
select is(public.agent_mark_control_v1('submit',jsonb_build_object('run_id',t.value->>'run_id','result',r.value,'fingerprint',repeat('c',64)))->>'accepted','true','accepted identical submission replays its receipt') from agent_test_tasks t cross join agent_test_result r;
select throws_ok($q$select public.agent_mark_control_v1('submit',jsonb_build_object('run_id',t.value->>'run_id','result',r.value,'fingerprint',repeat('d',64))) from agent_test_tasks t cross join agent_test_result r$q$,'P0001','MARK_RESULT_CONFLICT','a changed result cannot overwrite an accepted task');

insert into public.problems(id,user_id,subject_id,title,content,assets,solution_assets,status,parts,source,is_optional)
values('c2500000-0000-4000-8000-000000000002','a2500000-0000-4000-8000-000000000001','b2500000-0000-4000-8000-000000000001','Agent fixture','已知三个物理量','[]','[]','needs_review','[{"index":1,"type":"short_answer","content":"求第四个物理量"}]','{}',false);
select lives_ok($q$select public.inherit_problem_marks('[{"source_problem_id":"c2500000-0000-4000-8000-000000000001","destination_problem_id":"c2500000-0000-4000-8000-000000000002"}]')$q$,'copying accepted semantics remains supported');
select is((select count(*)::integer from public.problem_mark_methods where problem_id='c2500000-0000-4000-8000-000000000002'),1,'copy inherits method preferences and evidence');

update public.problems set title='Changed objective' where id='c2500000-0000-4000-8000-000000000001';
select is(jsonb_array_length(public.get_problem_semantics('c2500000-0000-4000-8000-000000000001')->'methods'->'recommended'),0,'an objective edit hides old method results');
select ok(not has_table_privilege('authenticated','public.problem_mark_agent_tasks','SELECT'),'private execution context and task credentials are not exposed to end users');

create temporary table agent_recovery(value jsonb);
insert into agent_recovery select public.agent_mark_control_v1('claim',jsonb_build_object('worker_id','old-worker','registry_source_sha',repeat('a',40),'registry_content_sha256',encode(extensions.digest(value,'sha256'),'hex'),'bundle_sha256',repeat('b',64),'skill_version','1.0.0')) from agent_test_artifact;
select public.agent_mark_control_v1('bind',jsonb_build_object('run_id',value->>'run_id','worker_id','old-worker','session_id','ses_recovery_fixture')) from agent_recovery;
update public.problem_mark_agent_tasks set lease_until=clock_timestamp()-interval '1 second' where run_id=(select (value->>'run_id')::uuid from agent_recovery);
update public.problem_mark_annotations set lease_until=clock_timestamp()-interval '1 second' where problem_id='c2500000-0000-4000-8000-000000000001';
select is(public.agent_mark_control_v1('claim',jsonb_build_object('worker_id','replacement-worker','allow_new',false,'registry_source_sha',repeat('a',40),'registry_content_sha256',encode(extensions.digest(a.value,'sha256'),'hex'),'bundle_sha256',repeat('b',64),'skill_version','1.0.0'))->>'run_id',r.value->>'run_id','recovery keeps the original run even when new admission is disabled') from agent_test_artifact a cross join agent_recovery r;
select is((select session_id from public.problem_mark_agent_tasks where run_id=(select (value->>'run_id')::uuid from agent_recovery)),'ses_recovery_fixture','recovery preserves the single bound session');
select throws_ok($q$select public.agent_mark_control_v1('renew',jsonb_build_object('run_id',value->>'run_id','worker_id','old-worker')) from agent_recovery$q$,'P0001','MARK_WORKER_MISMATCH','a replaced worker cannot renew the reclaimed task');
select throws_ok($q$select public.agent_mark_control_v1('fail',jsonb_build_object('run_id',value->>'run_id','worker_id','old-worker','error_code','MARK_TRANSPORT_FAILED')) from agent_recovery$q$,'P0001','MARK_WORKER_MISMATCH','a replaced worker cannot fail its successor');
update public.problems set content='New revision while the model is running' where id='c2500000-0000-4000-8000-000000000001';
select throws_ok($q$select public.agent_mark_control_v1('submit',jsonb_build_object('run_id',t.value->>'run_id','result',r.value,'fingerprint',repeat('e',64))) from agent_recovery t cross join agent_test_result r$q$,'P0001','PROBLEM_MARK_LEASE_STALE','an in-flight result cannot overwrite a newer Problem revision');
select lives_ok($q$select public.agent_mark_control_v1('fail',jsonb_build_object('run_id',value->>'run_id','worker_id','replacement-worker','error_code','MARK_LEASE_LOST')) from agent_recovery$q$,'retiring the old run releases its lease without abandoning the newer revision');
select is((select status from public.problem_mark_annotations where problem_id='c2500000-0000-4000-8000-000000000001'),'pending','the newer objective revision remains queued');
truncate agent_recovery;
insert into agent_recovery select public.agent_mark_control_v1('claim',jsonb_build_object('worker_id','deadline-worker','registry_source_sha',repeat('a',40),'registry_content_sha256',encode(extensions.digest(value,'sha256'),'hex'),'bundle_sha256',repeat('b',64),'skill_version','1.0.0')) from agent_test_artifact;
update public.problem_mark_agent_tasks set deadline_at=clock_timestamp()-interval '1 second' where run_id=(select (value->>'run_id')::uuid from agent_recovery);
select throws_ok($q$select public.agent_mark_control_v1('renew',jsonb_build_object('run_id',value->>'run_id','worker_id','deadline-worker')) from agent_recovery$q$,'P0001','AGENT_DEADLINE_EXCEEDED','the overall task deadline bounds continued execution');
select public.agent_mark_control_v1('fail',jsonb_build_object('run_id',value->>'run_id','worker_id','deadline-worker','error_code','AGENT_DEADLINE_EXCEEDED')) from agent_recovery;
select is((select status from public.problem_mark_annotations where problem_id='c2500000-0000-4000-8000-000000000001'),'abandoned','a definite Agent failure does not auto-replay as a fresh run');
select is(public.get_problem_semantics('c2500000-0000-4000-8000-000000000001')->>'annotation_status','failed','terminal failure remains readable by the public Problem contract');
select public.requeue_problem_mark_annotation('c2500000-0000-4000-8000-000000000001');
create temporary table rag_claim(value jsonb);
insert into rag_claim select public.claim_problem_mark_annotation('c2500000-0000-4000-8000-000000000001',120);
create temporary table rag_context(value jsonb);
insert into rag_context select public.prepare_problem_mark_annotation('c2500000-0000-4000-8000-000000000001',(value->>'semantic_revision')::bigint,(value->>'lease_token')::uuid) from rag_claim;
select lives_ok($q$select public.commit_problem_mark_annotation_run((value->>'run_id')::uuid,(value->>'lease_token')::uuid,repeat('a',64),repeat('b',64),'rag-profile','query-v1','retriever-v1','fixture-model','prompt-v1','selected','["physics.skill.motion"]','[{"mark_key":"physics.knowledge.kinematics","role":"required","part_index":null},{"mark_key":"physics.skill.motion","role":"required","part_index":1}]','[]','{}') from rag_context$q$,'the original RAG commit works after the Agent migration');
select is((select executor from public.problem_mark_annotation_runs where id=(select (value->>'run_id')::uuid from rag_context)),'rag','legacy runs retain truthful executor metadata');
select is((select count(*)::integer from public.problem_marks where problem_id='c2500000-0000-4000-8000-000000000001' and is_user_override),1,'the original RAG commit also preserves user overrides');
select is((select count(*)::integer from public.problem_mark_methods where problem_id='c2500000-0000-4000-8000-000000000001' and not is_user_override),0,'switching to RAG replaces derived Agent method preferences');
select * from finish();
rollback;
