-- Give each newly claimed Agent task its own execution budget.
-- Existing task deadlines and the RPC privileges are preserved.
create or replace function public.agent_mark_control_v1(p_action text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
#variable_conflict use_variable
declare
  t public.problem_mark_agent_tasks%rowtype;
  a public.problem_mark_annotations%rowtype;
  c jsonb; claim jsonb; assignments jsonb; unresolved jsonb; item jsonb;
  skills jsonb; result jsonb; receipt jsonb; new_token uuid;
  v_status text; v_worker text := p_payload->>'worker_id'; v_revision bigint;
  claimed_at timestamptz;
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
    claimed_at:=clock_timestamp();
    perform set_config('wqn.mark_executor','agent',true);
    c:=public.prepare_problem_mark_annotation(a.problem_id,a.semantic_revision,(claim->>'lease_token')::uuid);
    perform set_config('wqn.mark_executor','',true);
    -- Keep queue timing and start the execution budget at the first claim.
    insert into public.problem_mark_agent_tasks(run_id,problem_id,semantic_revision,registry_revision_id,worker_id,lease_token,lease_until,queued_at,created_at,deadline_at,context,bundle_sha256,skill_version)
      values((c->>'run_id')::uuid,a.problem_id,a.semantic_revision,(c->>'registry_revision_id')::bigint,v_worker,
        (claim->>'lease_token')::uuid,(claim->>'lease_until')::timestamptz,a.updated_at,claimed_at,
        claimed_at+interval '300 seconds',c,p_payload->>'bundle_sha256',p_payload->>'skill_version') returning * into t;
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
