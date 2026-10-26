-- One Problem, one durable OpenCode session. Only the service can execute jobs.
alter table public.problem_mark_annotation_runs
  add column executor text not null default 'rag' check (executor in ('rag','agent'));

-- Run records are immutable once processing finishes. Set executor at INSERT,
-- and keep late usage accounting on the separate task row.
create function private.stamp_mark_executor() returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('wqn.mark_executor',true)='agent' then new.executor:='agent'; end if;
  return new;
end $$;
create trigger stamp_mark_executor before insert on public.problem_mark_annotation_runs
for each row execute function private.stamp_mark_executor();

create table public.problem_mark_agent_tasks (
  run_id uuid primary key references public.problem_mark_annotation_runs(id) on delete cascade,
  problem_id uuid not null references public.problems(id) on delete cascade,
  semantic_revision bigint not null,
  registry_revision_id bigint references public.knowledge_registry_revisions(id),
  worker_id text not null,
  state text not null default 'processing' check (state in ('processing','committed','failed','stale','unknown')),
  lease_token uuid not null,
  lease_until timestamptz not null,
  queued_at timestamptz not null,
  deadline_at timestamptz not null,
  session_id text unique,
  prompt_state text not null default 'new' check (prompt_state in ('new','submitting','submitted')),
  context jsonb not null,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  skill_version text not null,
  result jsonb,
  result_fingerprint text,
  receipt jsonb,
  telemetry jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index problem_mark_agent_tasks_recover_idx on public.problem_mark_agent_tasks(lease_until) where state='processing';
alter table public.problem_mark_agent_tasks enable row level security;
revoke all on public.problem_mark_agent_tasks from public,anon,authenticated;
grant all on public.problem_mark_agent_tasks to service_role;

create table public.problem_mark_methods (
  problem_id uuid not null references public.problems(id) on delete cascade,
  mark_key text not null references public.knowledge_marks(stable_key),
  part_index smallint check (part_index between 1 and 10),
  preference text not null check (preference in ('recommended','alternative')),
  run_id uuid not null references public.problem_mark_annotation_runs(id),
  registry_revision_id bigint not null references public.knowledge_registry_revisions(id),
  semantic_revision bigint not null,
  evidence jsonb not null,
  is_user_override boolean not null default false,
  constraint problem_mark_methods_identity unique nulls not distinct(problem_id,part_index,mark_key)
);
create index problem_mark_methods_key_idx on public.problem_mark_methods(mark_key,problem_id);
alter table public.problem_mark_methods enable row level security;
revoke all on public.problem_mark_methods from public,anon,authenticated;
grant select on public.problem_mark_methods to authenticated;
grant all on public.problem_mark_methods to service_role;
create policy problem_mark_methods_select on public.problem_mark_methods for select to authenticated
using (exists(select 1 from public.problems p where p.id=problem_id));

create function private.close_agent_mark_task(p_run_id uuid,p_state text,p_error text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.problem_mark_agent_tasks%rowtype;
begin
  select * into strict t from public.problem_mark_agent_tasks where run_id=p_run_id for update;
  if t.state<>'processing' then return to_jsonb(t); end if;
  update public.problem_mark_annotation_runs set status=case when p_state='stale' then 'stale' else 'failed' end,
    last_error_code=p_error,completed_at=clock_timestamp() where id=t.run_id and status='processing';
  update public.problem_mark_annotations set
    status=case when semantic_revision=t.semantic_revision then 'abandoned' else status end,
    last_error_code=case when semantic_revision=t.semantic_revision then p_error else last_error_code end,
    completed_at=case when semantic_revision=t.semantic_revision then clock_timestamp() else completed_at end,
    lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where problem_id=t.problem_id and lease_token=t.lease_token;
  update public.problem_mark_agent_tasks set state=p_state,error_code=p_error,updated_at=clock_timestamp()
    where run_id=t.run_id returning * into t;
  return to_jsonb(t);
end $$;

create or replace function public.agent_mark_control_v1(p_action text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
#variable_conflict use_variable
declare
  t public.problem_mark_agent_tasks%rowtype;
  a public.problem_mark_annotations%rowtype;
  c jsonb; claim jsonb; assignments jsonb; unresolved jsonb; item jsonb;
  skills jsonb; result jsonb; receipt jsonb; new_token uuid;
  v_status text; v_worker text := p_payload->>'worker_id'; v_revision bigint;
begin
  if p_action='health' then
    return jsonb_build_object('ready',exists(select 1 from public.knowledge_registry_state s join public.knowledge_registry_revisions r on r.id=s.active_revision_id
      where s.singleton and r.source_sha=p_payload->>'registry_source_sha' and r.content_sha256=p_payload->>'registry_content_sha256'));
  end if;
  if p_action='claim' then
    if v_worker is null or length(v_worker) not between 1 and 100 then raise exception 'INVALID_WORKER'; end if;
    if not exists(select 1 from public.knowledge_registry_state s join public.knowledge_registry_revisions r on r.id=s.active_revision_id
      where s.singleton and r.source_sha=p_payload->>'registry_source_sha' and r.content_sha256=p_payload->>'registry_content_sha256') then
      raise exception 'REGISTRY_LOCK_MISMATCH';
    end if;
    -- Recover the same session before starting a fresh task. Never replay a prompt.
    select * into t from public.problem_mark_agent_tasks where state='processing' and lease_until<=clock_timestamp()
      order by lease_until for update skip locked limit 1;
    if found then
      select * into a from public.problem_mark_annotations where problem_id=t.problem_id for update;
      if a.semantic_revision<>t.semantic_revision or a.lease_token is distinct from t.lease_token then
        return private.close_agent_mark_task(t.run_id,'stale','PROBLEM_MARK_LEASE_STALE');
      end if;
      if t.deadline_at<=clock_timestamp() then return private.close_agent_mark_task(t.run_id,'failed','AGENT_DEADLINE_EXCEEDED'); end if;
      new_token:=gen_random_uuid();
      update public.problem_mark_annotations set lease_token=new_token,lease_until=clock_timestamp()+interval '90 seconds' where problem_id=t.problem_id;
      update public.problem_mark_agent_tasks set worker_id=v_worker,lease_token=new_token,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
        where run_id=t.run_id returning * into t;
      return to_jsonb(t);
    end if;
    if p_payload->>'allow_new'='false' then return null; end if;
    -- Claim only one free slot. Agent failures require an explicit requeue.
    select annotation.* into a from public.problem_mark_annotations annotation join public.problems p on p.id=annotation.problem_id
      where annotation.status='pending' and annotation.semantic_revision=p.semantic_revision
      and annotation.next_retry_at<=clock_timestamp() and (annotation.lease_until is null or annotation.lease_until<=clock_timestamp())
      order by annotation.next_retry_at,annotation.problem_id for update of annotation skip locked limit 1;
    if not found then return null; end if;
    claim:=public.claim_problem_mark_annotation(a.problem_id,90);
    if claim is null then return null; end if;
    perform set_config('wqn.mark_executor','agent',true);
    c:=public.prepare_problem_mark_annotation(a.problem_id,a.semantic_revision,(claim->>'lease_token')::uuid);
    perform set_config('wqn.mark_executor','',true);
    insert into public.problem_mark_agent_tasks(run_id,problem_id,semantic_revision,registry_revision_id,worker_id,lease_token,lease_until,queued_at,deadline_at,context,bundle_sha256,skill_version)
      values((c->>'run_id')::uuid,a.problem_id,a.semantic_revision,(c->>'registry_revision_id')::bigint,v_worker,
        (claim->>'lease_token')::uuid,(claim->>'lease_until')::timestamptz,a.updated_at,
        a.updated_at+interval '300 seconds',c,p_payload->>'bundle_sha256',p_payload->>'skill_version') returning * into t;
    if t.deadline_at<=clock_timestamp() then return private.close_agent_mark_task(t.run_id,'failed','AGENT_QUEUE_DEADLINE_EXCEEDED'); end if;
    return to_jsonb(t);
  end if;
  select * into t from public.problem_mark_agent_tasks where run_id=(p_payload->>'run_id')::uuid for update;
  if not found then raise exception 'MARK_TASK_NOT_FOUND'; end if;
  if p_action='read' then return to_jsonb(t); end if;
  if p_action='submit' and t.state='committed' then
    if t.result_fingerprint is distinct from p_payload->>'fingerprint' then raise exception 'MARK_RESULT_CONFLICT'; end if;
    return t.receipt;
  end if;
  if p_action='telemetry' then
    if t.worker_id is distinct from v_worker then raise exception 'MARK_WORKER_MISMATCH'; end if;
    update public.problem_mark_agent_tasks set telemetry=p_payload->'telemetry',updated_at=clock_timestamp() where run_id=t.run_id;
    return jsonb_build_object('stored',true);
  end if;
  if t.state<>'processing' then raise exception 'MARK_TASK_NOT_ACTIVE'; end if;
  if p_action in ('renew','bind','prompt') and (
    (p_payload ? 'bundle_sha256' and t.bundle_sha256 is distinct from p_payload->>'bundle_sha256')
    or t.registry_revision_id is distinct from (select active_revision_id from public.knowledge_registry_state where singleton)
  ) then
    perform private.close_agent_mark_task(t.run_id,'stale','REGISTRY_REVISION_STALE');
    update public.problem_mark_annotations set status='pending',completed_at=null,next_retry_at=clock_timestamp(),updated_at=clock_timestamp()
      where problem_id=t.problem_id and semantic_revision=t.semantic_revision and lease_token is null;
    select * into t from public.problem_mark_agent_tasks where run_id=t.run_id;
    return to_jsonb(t);
  end if;
  if p_action='fail' then
    if t.worker_id is distinct from v_worker then raise exception 'MARK_WORKER_MISMATCH'; end if;
    return private.close_agent_mark_task(t.run_id,case when p_payload->>'error_code'='PROMPT_OUTCOME_UNKNOWN' then 'unknown' else 'failed' end,left(p_payload->>'error_code',100));
  end if;
  select * into a from public.problem_mark_annotations where problem_id=t.problem_id for update;
  if a.semantic_revision<>t.semantic_revision or a.lease_token is distinct from t.lease_token
     or t.lease_until<=clock_timestamp() then raise exception 'PROBLEM_MARK_LEASE_STALE'; end if;
  if t.deadline_at<=clock_timestamp() then raise exception 'AGENT_DEADLINE_EXCEEDED'; end if;
  if p_action in ('renew','bind','prompt') then
    if t.worker_id is distinct from v_worker then raise exception 'MARK_WORKER_MISMATCH'; end if;
    if p_action='renew' then
      new_token:=gen_random_uuid();
      update public.problem_mark_annotations set lease_token=new_token,lease_until=clock_timestamp()+interval '90 seconds' where problem_id=t.problem_id;
      update public.problem_mark_agent_tasks set lease_token=new_token,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where run_id=t.run_id returning * into t;
    elsif p_action='bind' then
      if (p_payload->>'session_id') !~ '^ses_[A-Za-z0-9_-]+$' or (t.session_id is not null and t.session_id<>p_payload->>'session_id') then raise exception 'MARK_SESSION_CONFLICT'; end if;
      update public.problem_mark_agent_tasks set session_id=p_payload->>'session_id',updated_at=clock_timestamp() where run_id=t.run_id returning * into t;
    else
      if p_payload->>'prompt_state' not in ('submitting','submitted') or (t.prompt_state='submitted' and p_payload->>'prompt_state'<>'submitted') then raise exception 'INVALID_PROMPT_STATE'; end if;
      update public.problem_mark_agent_tasks set prompt_state=p_payload->>'prompt_state',updated_at=clock_timestamp() where run_id=t.run_id returning * into t;
    end if;
    return to_jsonb(t);
  end if;
  if p_action<>'submit' then raise exception 'INVALID_MARK_ACTION'; end if;
  result:=p_payload->'result';
  select coalesce(jsonb_agg(value-'evidence'),'[]'::jsonb) into assignments from jsonb_array_elements(result->'assignments');
  select coalesce(jsonb_agg(jsonb_build_object('role','target','kind',value->>'kind','part_index',value->'part_index','reason',
    case when value->>'reason'='missing_image' then 'insufficient_problem_context' else value->>'reason' end)),'[]'::jsonb)
    into unresolved from jsonb_array_elements(result->'unresolved');
  select coalesce(jsonb_agg(m.stable_key),'[]'::jsonb) into skills from public.knowledge_marks m
    where m.subject_key=t.context->>'subject_key' and m.kind='skill' and m.status='active';
  -- Existing objective-assignment validation remains authoritative. Method
  -- preferences are a separate relation and must not become prerequisite claims.
  perform private.validate_problem_mark_result(t.problem_id,t.semantic_revision,t.registry_revision_id,skills,assignments,unresolved,
    case when exists(select 1 from jsonb_array_elements(unresolved) u where u->>'kind'='skill') then 'unresolved'
      when exists(select 1 from jsonb_array_elements(assignments) x join public.knowledge_marks m on m.stable_key=x->>'mark_key' where m.kind='skill') then 'selected' else 'no_applicable' end);
  for item in select * from jsonb_array_elements(result->'methods') loop
    if not exists(select 1 from public.knowledge_marks m where m.stable_key=item->>'mark_key' and m.subject_key=t.context->>'subject_key' and m.kind='skill' and m.status='active')
      or item->>'preference' not in ('recommended','alternative')
      or (item->'part_index'<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(t.context->'parts') p where p->>'index'=item->>'part_index')) then
      raise exception 'INVALID_MARK_METHOD';
    end if;
  end loop;
  delete from public.problem_marks where problem_id=t.problem_id and not is_user_override;
  insert into public.problem_marks(problem_id,mark_key,role,part_index,registry_revision_id,semantic_revision,source)
    select t.problem_id,value->>'mark_key',value->>'role',(value->>'part_index')::smallint,t.registry_revision_id,t.semantic_revision,'ai'
    from jsonb_array_elements(assignments) on conflict(problem_id,part_index,mark_key) do nothing;
  delete from public.problem_mark_methods where problem_id=t.problem_id and not is_user_override;
  insert into public.problem_mark_methods(problem_id,mark_key,part_index,preference,run_id,registry_revision_id,semantic_revision,evidence)
    select t.problem_id,value->>'mark_key',(value->>'part_index')::smallint,value->>'preference',t.run_id,t.registry_revision_id,t.semantic_revision,value->'evidence'
    from jsonb_array_elements(result->'methods') on conflict(problem_id,part_index,mark_key) do nothing;
  v_status:=case when jsonb_array_length(unresolved)>0 then 'unresolved' else 'resolved' end;
  update public.problem_mark_annotation_runs set status=v_status,assignments=assignments,unresolved=unresolved,marking_model=t.telemetry->>'model',
    objective_snapshot_hash=coalesce(p_payload->>'objective_snapshot_hash',encode(extensions.digest(t.context::text,'sha256'),'hex')),
    marking_prompt_version=t.skill_version,skill_resolution=case when exists(select 1 from jsonb_array_elements(unresolved) u where u->>'kind'='skill') then 'unresolved'
      when jsonb_array_length(result->'methods')>0 then 'selected' else 'no_applicable' end,
    retrieval_debug=jsonb_build_object('executor','agent','bundle_sha256',t.bundle_sha256),completed_at=clock_timestamp() where id=t.run_id;
  update public.problem_mark_annotations set registry_revision_id=t.registry_revision_id,active_run_id=t.run_id,status=v_status,unresolved=unresolved,
    lease_token=null,lease_until=null,last_error_code=null,completed_at=clock_timestamp(),updated_at=clock_timestamp() where problem_id=t.problem_id;
  receipt:=jsonb_build_object('accepted',true,'run_id',t.run_id,'problem_id',t.problem_id,'semantic_revision',t.semantic_revision,'status',v_status,
    'assignments',jsonb_array_length(assignments),'methods',jsonb_array_length(result->'methods'),'unresolved',jsonb_array_length(unresolved));
  update public.problem_mark_agent_tasks set state='committed',result=result,result_fingerprint=p_payload->>'fingerprint',receipt=receipt,updated_at=clock_timestamp() where run_id=t.run_id;
  return receipt;
end $$;
revoke all on function public.agent_mark_control_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.agent_mark_control_v1(text,jsonb) to service_role;
revoke all on function private.close_agent_mark_task(uuid,text,text) from public,anon,authenticated;
grant execute on function private.close_agent_mark_task(uuid,text,text) to service_role;

-- Keep the stable read surface and add the method preference projection.
alter function public.get_problem_semantics(uuid) rename to get_problem_semantics_before_agent_v1;
create function public.get_problem_semantics(p_problem_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
  select public.get_problem_semantics_before_agent_v1(p_problem_id) || jsonb_build_object(
    'annotation_status',case when (select a.status from public.problem_mark_annotations a where a.problem_id=p_problem_id)='abandoned' then 'failed' else public.get_problem_semantics_before_agent_v1(p_problem_id)->>'annotation_status' end,
    'methods',jsonb_build_object(
    'recommended',coalesce((select jsonb_agg(jsonb_build_object('part_index',x.part_index,'mark',jsonb_build_object('stable_key',m.stable_key,'name',m.name,'kind',m.kind,'subject',m.subject_key,'status',m.status,'parent',m.parent_key),'evidence',x.evidence) order by x.part_index nulls first,m.stable_key)
      from public.problem_mark_methods x join public.problems p on p.id=x.problem_id and p.semantic_revision=x.semantic_revision join public.knowledge_marks m on m.stable_key=x.mark_key where x.problem_id=p_problem_id and x.preference='recommended'),'[]'::jsonb),
    'alternative',coalesce((select jsonb_agg(jsonb_build_object('part_index',x.part_index,'mark',jsonb_build_object('stable_key',m.stable_key,'name',m.name,'kind',m.kind,'subject',m.subject_key,'status',m.status,'parent',m.parent_key),'evidence',x.evidence) order by x.part_index nulls first,m.stable_key)
      from public.problem_mark_methods x join public.problems p on p.id=x.problem_id and p.semantic_revision=x.semantic_revision join public.knowledge_marks m on m.stable_key=x.mark_key where x.problem_id=p_problem_id and x.preference='alternative'),'[]'::jsonb)
  ));
$$;
revoke all on function public.get_problem_semantics(uuid) from public,anon;
grant execute on function public.get_problem_semantics(uuid) to authenticated,service_role;

-- Repair the currently used RAG commit, preserving its other CAS checks.
do $$ declare definition text; begin
  definition:=pg_get_functiondef('public.commit_problem_mark_annotation_run(uuid,uuid,text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  if position('where problem_id = v_run.problem_id;' in definition)=0 then raise exception 'UNKNOWN_MARK_COMMIT_DEFINITION'; end if;
  definition:=replace(definition,'where problem_id = v_run.problem_id;','where problem_id = v_run.problem_id and not is_user_override;');
  definition:=replace(definition,'from jsonb_array_elements(p_assignments) item;','from jsonb_array_elements(p_assignments) item on conflict (problem_id, part_index, mark_key) do nothing;');
  execute definition;
end $$;

-- An accepted RAG run replaces derived Agent method preferences, too.
create function private.clear_previous_agent_methods() returns trigger language plpgsql set search_path='' as $$
begin
  if new.executor='rag' and new.status in ('resolved','unresolved') then
    delete from public.problem_mark_methods where problem_id=new.problem_id and not is_user_override;
  end if;
  return new;
end $$;
create trigger clear_previous_agent_methods after insert or update of status on public.problem_mark_annotation_runs
for each row execute function private.clear_previous_agent_methods();

-- Copy only the methods belonging to the objective revision already accepted
-- by the existing inheritance function. Keep the source run as provenance.
alter function public.inherit_problem_marks(jsonb) rename to inherit_problem_marks_before_agent_v1;
create function public.inherit_problem_marks(p_mappings jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; mapping jsonb; destination_run uuid;
begin
  result:=public.inherit_problem_marks_before_agent_v1(p_mappings);
  for mapping in select * from jsonb_array_elements(p_mappings) loop
    select a.active_run_id into destination_run from public.problem_mark_annotations a
      where a.problem_id=(mapping->>'destination_problem_id')::uuid and a.status in ('resolved','unresolved');
    if destination_run is not null then
      insert into public.problem_mark_methods(problem_id,mark_key,part_index,preference,run_id,registry_revision_id,semantic_revision,evidence)
        select p.id,x.mark_key,x.part_index,x.preference,destination_run,x.registry_revision_id,p.semantic_revision,x.evidence
        from public.problem_mark_methods x join public.problems s on s.id=x.problem_id and s.semantic_revision=x.semantic_revision
        join public.problems p on p.id=(mapping->>'destination_problem_id')::uuid
        where x.problem_id=(mapping->>'source_problem_id')::uuid
        on conflict(problem_id,part_index,mark_key) do nothing;
    end if;
  end loop;
  return result;
end $$;
revoke all on function public.inherit_problem_marks(jsonb) from public,anon,authenticated;
grant execute on function public.inherit_problem_marks(jsonb) to service_role;

alter function public.problem_mark_annotation_health() rename to problem_mark_annotation_health_before_agent_v1;
create function public.problem_mark_annotation_health() returns jsonb language sql stable security invoker set search_path='' as $$
  select public.problem_mark_annotation_health_before_agent_v1() || jsonb_build_object('agent',jsonb_build_object(
    'processing',(select count(*) from public.problem_mark_agent_tasks where state='processing'),
    'recent_tasks',coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
      select jsonb_build_object('run_id',run_id,'problem_id',problem_id,'state',state,'session_id',session_id,'error_code',error_code,
        'queued_at',queued_at,'created_at',created_at,'deadline_at',deadline_at,'updated_at',updated_at,'telemetry',telemetry) x
      from public.problem_mark_agent_tasks order by created_at desc limit 20
    ) recent),'[]'::jsonb)
  ));
$$;
revoke all on function public.problem_mark_annotation_health() from public,anon,authenticated;
grant execute on function public.problem_mark_annotation_health() to service_role;
