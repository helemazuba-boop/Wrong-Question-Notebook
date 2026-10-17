-- Durable admission at the physical provider boundary. No client/RLS access.
create table public.opencode_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  session_id text not null,
  user_id uuid not null,
  -- Immutable identity snapshot: deleting a device must not erase spending.
  device_id uuid not null,
  request_id text not null check (request_id ~ '^[0-9a-f]{16}$'),
  policy jsonb not null,
  state text not null default 'armed' check (state in ('armed','running','completed','failed','cancelled','unknown')),
  fallback_count integer not null default 0 check (fallback_count between 0 and 1),
  request_count integer not null default 0,
  steps integer not null default 0,
  output_seen boolean not null default false,
  tool_seen boolean not null default false,
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  actual_model text,
  error_kind text,
  provider_status integer,
  provider_code text,
  retry_after_ms bigint,
  fallback_at timestamptz,
  created_at timestamptz not null default now(),
  deadline timestamptz not null,
  unique(scope,device_id,request_id)
);
create unique index opencode_task_session_active on public.opencode_agent_tasks(scope,session_id)
  where state in ('armed','running','unknown');
create index opencode_task_user_window on public.opencode_agent_tasks(user_id,created_at);
create index opencode_task_session_history on public.opencode_agent_tasks(scope,session_id,created_at desc);
create table public.opencode_provider_attempts (
  id uuid primary key,
  task_id uuid not null references public.opencode_agent_tasks(id) on delete cascade,
  model text not null,
  kind text not null check (kind in ('primary','compaction','title','generate')),
  reserved_tokens bigint not null check (reserved_tokens > 0),
  used_tokens bigint,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);
create index opencode_attempt_task_window on public.opencode_provider_attempts(task_id,created_at);

-- A child belongs to its original admission across plugin/server restarts.
create table public.opencode_agent_task_sessions (
  scope text not null,
  session_id text not null,
  task_id uuid not null references public.opencode_agent_tasks(id) on delete cascade,
  primary key(scope,session_id)
);
create table public.opencode_model_cooldowns (
  user_id uuid not null,
  scope text not null,
  model text not null,
  until_at timestamptz not null,
  primary key(user_id,scope,model)
);
alter table public.opencode_agent_task_sessions enable row level security;
alter table public.opencode_agent_tasks enable row level security;
alter table public.opencode_provider_attempts enable row level security;
alter table public.opencode_model_cooldowns enable row level security;
revoke all on public.opencode_agent_tasks, public.opencode_provider_attempts, public.opencode_model_cooldowns, public.opencode_agent_task_sessions from public,anon,authenticated;
grant all on public.opencode_agent_tasks, public.opencode_provider_attempts, public.opencode_model_cooldowns, public.opencode_agent_task_sessions to service_role;

create function public.opencode_agent_control_v1(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  t public.opencode_agent_tasks%rowtype;
  a public.opencode_provider_attempts%rowtype;
  limits jsonb;
  chosen_model text;
  primary_model text;
  fallback_model text;
  amount bigint;
  used bigint;
  recent_tokens bigint;
  recent_fallbacks bigint;
  input_bound bigint;
  output_bound bigint;
begin
  if p_action='arm' then
    perform pg_advisory_xact_lock(hashtextextended('opencode-user:'||(p_payload->>'userId'),0));
    perform pg_advisory_xact_lock(hashtextextended('opencode-session:'||(p_payload->>'scope')||':'||(p_payload->>'sessionId'),0));
    select * into t from public.opencode_agent_tasks where scope=p_payload->>'scope' and device_id=(p_payload->>'deviceId')::uuid and request_id=p_payload->>'requestId';
    if found then
      if t.session_id<>p_payload->>'sessionId' or t.user_id<>(p_payload->>'userId')::uuid then raise exception 'TASK_CONFLICT'; end if;
      return to_jsonb(t);
    end if;
    limits=p_payload->'policy'->'limits';
    if limits is null or not (limits ?& array['maxInputTokens','maxOutputTokens','maxTotalTokens','maxProviderRequests','maxSteps','maxDurationMs','maxFallbacksPer24Hours','maxUserTokensPer24Hours','cooldownMs','quotaGroups']) or (limits->>'maxDurationMs')::bigint not between 1 and 1800000 then raise exception 'INVALID_POLICY'; end if;
    insert into public.opencode_agent_tasks(scope,session_id,user_id,device_id,request_id,policy,deadline)
    values(p_payload->>'scope',p_payload->>'sessionId',(p_payload->>'userId')::uuid,(p_payload->>'deviceId')::uuid,p_payload->>'requestId',p_payload->'policy',now()+((limits->>'maxDurationMs')::bigint*interval '1 millisecond')) returning * into t;
    return to_jsonb(t) || jsonb_build_object('primary_cooling',exists(select 1 from public.opencode_model_cooldowns c where c.user_id=t.user_id and c.scope=t.scope and c.model=t.policy->>'primary' and c.until_at>now()));
  end if;

  if p_action='lookup' then
    select original.* into t from public.opencode_agent_task_sessions child join public.opencode_agent_tasks original on original.id=child.task_id where child.scope=p_payload->>'scope' and child.session_id=p_payload->>'sessionId';
    if found then return to_jsonb(t); end if;
    select * into t from public.opencode_agent_tasks where scope=p_payload->>'scope' and session_id=p_payload->>'sessionId' order by created_at desc limit 1;
    if not found then return 'null'::jsonb; end if;
    return to_jsonb(t) || jsonb_build_object('primary_cooling',exists(select 1 from public.opencode_model_cooldowns c where c.user_id=t.user_id and c.scope=t.scope and c.model=t.policy->>'primary' and c.until_at>now()));
  end if;

  -- Read identity, lock the USER, then re-read/lock task: budget admission is
  -- serialized across devices, sessions, and independent OpenCode processes.
  select * into t from public.opencode_agent_tasks where id=(p_payload->>'taskId')::uuid;
  if not found then raise exception 'TASK_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('opencode-user:'||t.user_id::text,0));
  select * into t from public.opencode_agent_tasks where id=t.id for update;
  limits=t.policy->'limits';
  primary_model=t.policy->>'primary';
  fallback_model=t.policy->>'fallback';

  if p_action='cancel' then
    update public.opencode_agent_tasks set state='cancelled' where id=t.id and state in ('armed','running','unknown');
    return jsonb_build_object('ok',true);
  elsif p_action='finish' then
    if p_payload->>'state' not in ('completed','failed','unknown') then raise exception 'INVALID_STATE'; end if;
    update public.opencode_agent_tasks set state=p_payload->>'state' where id=t.id and state in ('armed','running','unknown');
    return jsonb_build_object('ok',true);
  elsif p_action='failure' then
    if p_payload->>'reason' not in ('rate_limited','quota_exhausted','unavailable','ineligible') then raise exception 'INVALID_FAILURE'; end if;
    update public.opencode_agent_tasks set error_kind=p_payload->>'reason',provider_status=(p_payload->>'status')::integer,provider_code=left(p_payload->>'code',128),retry_after_ms=least(86400000,greatest(0,coalesce((p_payload->>'retryAfterMs')::bigint,0))) where id=t.id;
    if p_payload->>'reason' in ('rate_limited','quota_exhausted','unavailable') and p_payload->>'model' in (primary_model,fallback_model) then
      insert into public.opencode_model_cooldowns values(t.user_id,t.scope,p_payload->>'model',now()+(greatest((limits->>'cooldownMs')::bigint,least(86400000,coalesce((p_payload->>'retryAfterMs')::bigint,0)))*interval '1 millisecond'))
        on conflict(user_id,scope,model) do update set until_at=greatest(opencode_model_cooldowns.until_at,excluded.until_at);
    end if;
    return jsonb_build_object('ok',true);
  elsif p_action='activity' then
    update public.opencode_agent_tasks set output_seen=output_seen or coalesce((p_payload->>'output')::boolean,false), tool_seen=tool_seen or coalesce((p_payload->>'tool')::boolean,false) where id=t.id;
    return jsonb_build_object('ok',true);
  elsif p_action='settle' then
    select * into a from public.opencode_provider_attempts where id=(p_payload->>'attemptId')::uuid and task_id=t.id for update;
    if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;
    if a.settled then return jsonb_build_object('ok',true); end if;
    used=(p_payload->>'usedTokens')::bigint;
    -- Unknown consumption retains the entire reservation. Never release on
    -- timeout/TTL or presume a rejected/failed request cost zero tokens.
    if used is not null and used<0 then raise exception 'INVALID_USAGE'; end if;
    update public.opencode_provider_attempts set settled=true,used_tokens=used where id=a.id;
    if used is not null then
      update public.opencode_agent_tasks set reserved_tokens=reserved_tokens-a.reserved_tokens+used,
        state=case when used>a.reserved_tokens and state<>'cancelled' then 'failed' else state end where id=t.id;
    end if;
    return jsonb_build_object('ok',true);
  end if;

  if t.state not in ('armed','running') or clock_timestamp()>=t.deadline then raise exception 'TASK_STOPPED'; end if;
  if p_action='bind' then
    if p_payload->>'sessionId' is null or p_payload->>'sessionId'=t.session_id then raise exception 'INVALID_CHILD'; end if;
    insert into public.opencode_agent_task_sessions values(t.scope,p_payload->>'sessionId',t.id) on conflict do nothing;
    if not exists(select 1 from public.opencode_agent_task_sessions child where child.scope=t.scope and child.session_id=p_payload->>'sessionId' and child.task_id=t.id) then raise exception 'CHILD_ALREADY_BOUND'; end if;
    update public.opencode_agent_tasks set tool_seen=true where id=t.id;
    return jsonb_build_object('ok',true);
  elsif p_action='fallback' then
    if t.fallback_count<>0 or t.output_seen or t.tool_seen or not ((t.request_count=1 and t.steps=1) or (t.request_count=0 and t.steps=0 and p_payload->>'reason'='model_unavailable')) then raise exception 'FALLBACK_UNSAFE'; end if;
    if fallback_model is null or p_payload->>'reason' not in ('rate_limited','quota_exhausted','unavailable','model_unavailable') then raise exception 'FALLBACK_INELIGIBLE'; end if;
    if p_payload->>'reason' in ('rate_limited','quota_exhausted') and
      (limits->'quotaGroups'->>primary_model is null or limits->'quotaGroups'->>fallback_model is null or limits->'quotaGroups'->>primary_model=limits->'quotaGroups'->>fallback_model) then raise exception 'SHARED_QUOTA'; end if;
    select coalesce(sum(fallback_count),0) into recent_fallbacks from public.opencode_agent_tasks where user_id=t.user_id and fallback_at>now()-interval '24 hours';
    if recent_fallbacks>=(limits->>'maxFallbacksPer24Hours')::integer then raise exception 'FALLBACK_WINDOW_EXHAUSTED'; end if;
    if exists(select 1 from public.opencode_agent_tasks where user_id=t.user_id and id<>t.id and fallback_count=1 and state in ('armed','running','unknown')) then raise exception 'FALLBACK_BUSY'; end if;
    if exists(select 1 from public.opencode_model_cooldowns c where c.user_id=t.user_id and c.scope=t.scope and c.model=fallback_model and c.until_at>now()) then raise exception 'MODEL_COOLDOWN'; end if;
    update public.opencode_agent_tasks set fallback_count=1,fallback_at=now(),actual_model=fallback_model,error_kind=p_payload->>'reason' where id=t.id;
    insert into public.opencode_model_cooldowns values(t.user_id,t.scope,primary_model,now()+((limits->>'cooldownMs')::bigint*interval '1 millisecond'))
      on conflict(user_id,scope,model) do update set until_at=greatest(opencode_model_cooldowns.until_at,excluded.until_at);
    return jsonb_build_object('ok',true,'model',fallback_model);
  elsif p_action='reserve' then
    chosen_model=p_payload->>'model';
    if chosen_model<>coalesce(t.actual_model,primary_model) then raise exception 'MODEL_NOT_ALLOWED'; end if;
    if exists(select 1 from public.opencode_model_cooldowns c where c.user_id=t.user_id and c.scope=t.scope and c.model=p_payload->>'model' and c.until_at>now()) then raise exception 'MODEL_COOLDOWN'; end if;
    input_bound=(p_payload->>'inputTokens')::bigint;
    output_bound=(p_payload->>'outputTokens')::bigint;
    if input_bound is null or output_bound is null or input_bound<=0 or output_bound<=0 or input_bound>(limits->>'maxInputTokens')::bigint or output_bound>(limits->>'maxOutputTokens')::bigint then raise exception 'REQUEST_BUDGET_EXHAUSTED'; end if;
    amount=input_bound+output_bound;
    if t.request_count>=(limits->>'maxProviderRequests')::integer or (p_payload->>'kind'='primary' and t.steps>=(limits->>'maxSteps')::integer) or t.reserved_tokens+amount>(limits->>'maxTotalTokens')::bigint then raise exception 'TASK_BUDGET_EXHAUSTED'; end if;
    select coalesce(sum(coalesce(attempt.used_tokens,attempt.reserved_tokens)),0) into recent_tokens from public.opencode_provider_attempts attempt join public.opencode_agent_tasks owner on owner.id=attempt.task_id where owner.user_id=t.user_id and (attempt.created_at>now()-interval '24 hours' or owner.state in ('armed','running','unknown'));
    if recent_tokens+amount>(limits->>'maxUserTokensPer24Hours')::bigint then raise exception 'USER_BUDGET_EXHAUSTED'; end if;
    insert into public.opencode_provider_attempts(id,task_id,model,kind,reserved_tokens) values((p_payload->>'attemptId')::uuid,t.id,chosen_model,p_payload->>'kind',amount);
    update public.opencode_agent_tasks set state='running',request_count=request_count+1,steps=steps+case when p_payload->>'kind'='primary' then 1 else 0 end,reserved_tokens=reserved_tokens+amount where id=t.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'INVALID_ACTION';
end $$;
revoke all on function public.opencode_agent_control_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.opencode_agent_control_v1(text,jsonb) to service_role;
