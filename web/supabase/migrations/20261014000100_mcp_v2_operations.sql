-- External MCP v2. Device/voice v1 functions and contracts stay intact.
create unique index if not exists oauth_tokens_id_user_id_uidx
  on public.oauth_tokens(id, user_id);
alter table public.problem_initial_idea_mcp_challenges
  alter column source_api_token_id drop not null;
alter table public.problem_initial_idea_mcp_challenges
  add column source_oauth_token_id uuid;
alter table public.problem_initial_idea_mcp_challenges
  add constraint problem_initial_idea_mcp_challenges_oauth_source_fkey
    foreign key(source_oauth_token_id, user_id) references public.oauth_tokens(id, user_id) on delete cascade,
  add constraint problem_initial_idea_mcp_challenges_one_source_check
    check(num_nonnulls(source_api_token_id, source_oauth_token_id) = 1);

create table public.mcp_v2_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null,
  operation_kind text not null,
  request_id text not null check(request_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  arguments jsonb not null check(jsonb_typeof(arguments) = 'object'),
  prepared jsonb,
  state text not null default 'preparing'
    check(state in ('preparing','prepared','awaiting_approval','committed','failed','rejected')),
  resource_type text,
  resource_id uuid,
  expected_revision bigint,
  expected_idea_revision bigint,
  credential_pat_id uuid,
  credential_oauth_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  recover_until timestamptz not null default (now() + interval '24 hours'),
  receipt jsonb,
  error jsonb,
  failure_diagnostic jsonb,
  approval_nonce_hash text,
  approval_nonce_expires_at timestamptz,
  preview_revision bigint,
  preview_idea_revision bigint,
  preview_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  committed_at timestamptz,
  unique(user_id, request_id),
  foreign key(credential_pat_id,user_id) references public.user_api_tokens(id,user_id) on delete set null (credential_pat_id),
  foreign key(credential_oauth_id,user_id) references public.oauth_tokens(id,user_id) on delete set null (credential_oauth_id),
  check(num_nonnulls(credential_pat_id,credential_oauth_id) <= 1),
  check(state <> 'committed' or (receipt is not null and committed_at is not null))
);
create index mcp_v2_operations_recovery_idx on public.mcp_v2_operations(recover_until)
  where state in ('preparing','prepared','failed');

create table public.mcp_v2_user_actions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.mcp_v2_operations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('images','initial_idea','word_deck_access')),
  state text not null default 'pending' check(state in ('pending','completed','dismissed')),
  resource_id uuid not null,
  challenge_id uuid references public.problem_initial_idea_mcp_challenges(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(operation_id,kind)
);
create table public.mcp_v2_approvals (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.mcp_v2_operations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check(decision in ('approved','rejected')),
  proposal_hash text not null,
  reviewed_hash text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb,
  approved_changes jsonb,
  created_at timestamptz not null default now(),
  unique(operation_id)
);
alter table public.mcp_v2_operations enable row level security;
alter table public.mcp_v2_user_actions enable row level security;
alter table public.mcp_v2_approvals enable row level security;
revoke all on public.mcp_v2_operations, public.mcp_v2_user_actions, public.mcp_v2_approvals from public, anon, authenticated;
grant all on public.mcp_v2_operations, public.mcp_v2_user_actions, public.mcp_v2_approvals to service_role;

create function private.mcp_v2_immutable_approval() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception using errcode = '55000', message = 'approval_is_immutable'; end;
$$;
create trigger mcp_v2_approval_immutable before update on public.mcp_v2_approvals
  for each row execute function private.mcp_v2_immutable_approval();

create function public.begin_mcp_operation_v2(
  p_user_id uuid, p_tool_name text, p_operation_kind text, p_request_id text,
  p_fingerprint text, p_arguments jsonb, p_credential_kind text, p_credential_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_op public.mcp_v2_operations%rowtype; v_inserted boolean := false;
begin
  if not exists(select 1 from public.user_profiles where id=p_user_id and is_active) then
    raise exception using errcode='42501',message='account_inactive'; end if;
  if p_credential_kind is null or p_credential_kind not in ('pat','oauth') or p_credential_id is null then
    raise exception using errcode='42501', message='credential_required';
  end if;
  insert into public.mcp_v2_operations(
    user_id,tool_name,operation_kind,request_id,fingerprint,arguments,
    credential_pat_id,credential_oauth_id
  ) values (
    p_user_id,p_tool_name,p_operation_kind,p_request_id,p_fingerprint,p_arguments,
    case when p_credential_kind='pat' then p_credential_id end,
    case when p_credential_kind='oauth' then p_credential_id end
  ) on conflict(user_id,request_id) do nothing;
  v_inserted := found;
  select * into strict v_op from public.mcp_v2_operations
    where user_id=p_user_id and request_id=p_request_id for update;
  if v_op.fingerprint <> p_fingerprint then
    raise exception using errcode='22023', message='request_id_reused';
  end if;
  if v_op.state in ('committed','awaiting_approval','rejected') then
    return to_jsonb(v_op) || jsonb_build_object('claimed',false);
  end if;
  if v_op.recover_until <= clock_timestamp() then
    return to_jsonb(v_op) || jsonb_build_object('claimed',false,'resume_expired',true);
  end if;
  if v_op.state='failed' and not coalesce((v_op.error->>'retryable')::boolean,false) then
    return to_jsonb(v_op) || jsonb_build_object('claimed',false);
  end if;
  if v_op.lease_expires_at > clock_timestamp() then
    return to_jsonb(v_op) || jsonb_build_object('claimed',false,'busy',true);
  end if;
  update public.mcp_v2_operations set
    lease_token=gen_random_uuid(), lease_expires_at=clock_timestamp()+interval '5 minutes',
    state=case when prepared is null then 'preparing' else 'prepared' end,
    credential_pat_id=case when p_credential_kind='pat' then p_credential_id end,
    credential_oauth_id=case when p_credential_kind='oauth' then p_credential_id end,
    error=null,failure_diagnostic=null, updated_at=clock_timestamp()
    where id=v_op.id returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('claimed',true,'new_operation',v_inserted);
end;
$$;

create function public.renew_mcp_operation_lease_v2(p_user_id uuid,p_operation_id uuid,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.mcp_v2_operations set lease_expires_at=clock_timestamp()+interval '5 minutes'
    where id=p_operation_id and user_id=p_user_id and lease_token=p_lease_token
      and state in ('preparing','prepared') and recover_until>clock_timestamp()
      and lease_expires_at>clock_timestamp();
  return found;
end;
$$;

create function public.prepare_mcp_operation_v2(
  p_user_id uuid,p_operation_id uuid,p_lease_token uuid,p_prepared jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op public.mcp_v2_operations%rowtype;
begin
  update public.mcp_v2_operations set prepared=p_prepared,state='prepared',updated_at=clock_timestamp()
    where id=p_operation_id and user_id=p_user_id and lease_token=p_lease_token
      and state in ('preparing','prepared') and lease_expires_at>clock_timestamp()
      and recover_until>clock_timestamp() returning * into v_op;
  if not found then raise exception using errcode='55000',message='operation_lease_lost'; end if;
  return to_jsonb(v_op);
end;
$$;

create function public.fail_mcp_operation_v2(
  p_user_id uuid,p_operation_id uuid,p_lease_token uuid,p_code text,p_retryable boolean
) returns void language plpgsql security definer set search_path='' as $$
begin
  update public.mcp_v2_operations set state='failed',
    error=jsonb_build_object('code',p_code,'message','操作尚未提交。','retryable',p_retryable),
    lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
    where id=p_operation_id and user_id=p_user_id and lease_token=p_lease_token
      and state in ('preparing','prepared');
end;
$$;

-- A fixed whitelist preserves the native transactional study implementation.
-- Function/argument names come from this code and pg_catalog, never model SQL.
create function private.invoke_mcp_native_rpc_v2(p_tool text,p_user_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_name text := p_payload->>'function'; v_args jsonb := p_payload->'args';
  v_allowed text[]; v_proc record; v_parameters text[] := '{}'; v_i integer;
  v_key text; v_type text; v_expression text; v_result jsonb;
  v_scope jsonb; v_domain text; v_id uuid;
begin
  v_allowed := case p_tool
    when 'start_note_reading_session' then array['create_note_study_session_v1']
    when 'start_word_study_session' then array['create_word_study_session_v1']
    when 'record_note_reading_observation' then array['record_note_study_observation_v1','skip_note_study_observation_v1']
    when 'record_word_study_observation' then array['record_study_observation_v1','skip_study_observation_v1']
    when 'set_note_reading_session_status' then array['set_web_note_study_session_status_v1']
    when 'set_word_study_session_status' then array['set_web_word_study_session_status_v1']
    when 'record_problem_review' then array['record_problem_review_v1']
    else '{}'::text[] end;
  if not v_name=any(v_allowed) or (v_args->>'p_user_id')::uuid is distinct from p_user_id
     or v_args->>'p_device_id' is not null then
    raise exception using errcode='42501',message='invalid_native_command';
  end if;
  v_domain:=case when p_tool like '%note%' then 'note' when p_tool like '%word%' then 'word' end;
  if v_domain is not null then
    if v_args ? 'p_scope' then v_scope:=v_args->'p_scope';
    else select scope into strict v_scope from public.study_sessions
      where id=(v_args->>'p_session_id')::uuid and user_id=p_user_id and domain=v_domain and device_id is null for update;
    end if;
    for v_id in select jsonb_array_elements_text(coalesce(v_scope->case when v_domain='note' then 'notebook_ids' else 'deck_ids' end,'[]'))::uuid loop
      if v_domain='note' and not exists(select 1 from public.notebooks n join public.notebook_ai_access a on a.notebook_id=n.id and a.user_id=p_user_id
        where n.id=v_id and n.user_id=p_user_id and n.archived_at is null and a.can_read) then
        raise exception using errcode='42501',message='notebook_permission_denied'; end if;
      if v_domain='word' and not exists(select 1 from public.word_decks d join public.word_deck_ai_access a on a.deck_id=d.id and a.user_id=p_user_id
        where d.id=v_id and (d.user_id=p_user_id or d.is_system) and d.is_active and a.can_read) then
        raise exception using errcode='42501',message='word_deck_permission_denied'; end if;
    end loop;
  end if;
  select p.* into strict v_proc from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_name;
  if exists(select 1 from jsonb_object_keys(v_args) k
    where not k=any(v_proc.proargnames[1:v_proc.pronargs])) then
    raise exception using errcode='22023',message='invalid_native_arguments';
  end if;
  for v_i in 1..v_proc.pronargs loop
    v_key := v_proc.proargnames[v_i];
    if not v_args ? v_key then continue; end if;
    v_type := pg_catalog.format_type(v_proc.proargtypes[v_i-1],null);
    if v_type in ('json','jsonb') then
      v_expression := format('nullif($1->%L,''null''::jsonb)::%s',v_key,v_type);
    elsif v_type like '%[]' then
      v_expression := format('case when $1->%L=''null''::jsonb then null else array(select jsonb_array_elements_text($1->%L))::%s end',v_key,v_key,v_type);
    else
      v_expression := format('($1->>%L)::%s',v_key,v_type);
    end if;
    v_parameters := array_append(v_parameters,format('%I => %s',v_key,v_expression));
  end loop;
  execute format('select to_jsonb(public.%I(%s))',v_name,array_to_string(v_parameters,','))
    into v_result using v_args;
  return v_result;
end;
$$;

create function private.mcp_insert_row_v2(p_table text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_names text; v_values text; v_result jsonb; v_rel regclass;
begin
  if p_table not in ('todos','notebook_notes','word_decks','word_entries') then
    raise exception using errcode='42501',message='invalid_insert_target';
  end if;
  v_rel := format('public.%I',p_table)::regclass;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not exists(
    select 1 from pg_catalog.pg_attribute a where a.attrelid=v_rel and a.attname=k
      and a.attnum>0 and not a.attisdropped and a.attgenerated=''
  )) then raise exception using errcode='22023',message='invalid_insert_fields'; end if;
  select string_agg(format('%I',k),',' order by k),string_agg(format('r.%I',k),',' order by k)
    into v_names,v_values from jsonb_object_keys(p_payload) k;
  execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_table,v_names,v_values,p_table,p_table)
    into v_result using p_payload;
  return v_result;
end;
$$;

create function public.commit_mcp_operation_v2(p_user_id uuid,p_operation_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_op public.mcp_v2_operations%rowtype; v_payload jsonb; v_row jsonb; v_receipt jsonb;
  v_table text; v_resource text; v_resource_id uuid; v_parent uuid;
  v_subject uuid; v_problem uuid; v_challenge uuid; v_tag uuid; v_tag_name text;
  v_code text; v_retryable boolean; v_constraint text; v_error_table text; v_error_schema text;
begin
  if not exists(select 1 from public.user_profiles where id=p_user_id and is_active) then
    raise exception using errcode='42501',message='account_inactive'; end if;
  select * into strict v_op from public.mcp_v2_operations
    where id=p_operation_id and user_id=p_user_id for update;
  if v_op.state='committed' then return to_jsonb(v_op)||jsonb_build_object('replayed',true); end if;
  if v_op.state<>'prepared' or v_op.lease_token is distinct from p_lease_token
     or v_op.lease_expires_at<=clock_timestamp() or v_op.recover_until<=clock_timestamp() then
    raise exception using errcode='55000',message='operation_lease_lost';
  end if;
  v_payload := v_op.prepared;
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||p_user_id,0));
  begin
    if not (
      exists(select 1 from public.user_api_tokens where id=v_op.credential_pat_id and user_id=p_user_id and revoked_at is null)
      or exists(select 1 from public.oauth_tokens where id=v_op.credential_oauth_id and user_id=p_user_id and revoked_at is null and access_token_expires_at>clock_timestamp())
    ) then raise exception using errcode='42501',message='credential_unavailable'; end if;
    if v_payload->>'kind'='rpc' then
      v_row := private.invoke_mcp_native_rpc_v2(v_op.tool_name,p_user_id,v_payload);
      v_resource := case when v_op.tool_name='record_problem_review' then 'problem'
        when v_op.tool_name like '%note%' then 'note_session' else 'word_session' end;
      v_resource_id := coalesce((v_op.arguments->>'session_id')::uuid,
        (v_row->>'session_id')::uuid,(v_row->>'id')::uuid,(v_op.arguments->>'problem_id')::uuid);
      v_receipt := jsonb_build_object('kind','rpc','function',v_payload->>'function','native_result',v_row);
    elsif v_payload->>'kind'='insert' then
      v_table := v_payload->>'table'; v_row := v_payload->'row';
      if v_op.tool_name='create_notebook_note' and v_table='notebook_notes' then
        v_parent := (v_row->>'notebook_id')::uuid;
        if not exists(select 1 from public.notebooks n join public.notebook_ai_access a
          on a.notebook_id=n.id and a.user_id=p_user_id
          where n.id=v_parent and n.user_id=p_user_id and n.archived_at is null and a.can_create)
          then raise exception using errcode='42501',message='notebook_permission_denied'; end if;
        if v_row->>'linked_problem_id' is not null and not exists(select 1 from public.problems
          where id=(v_row->>'linked_problem_id')::uuid and user_id=p_user_id)
          then raise exception using errcode='42501',message='linked_problem_not_owned'; end if;
        v_resource := 'note';
      elsif v_op.tool_name='create_todo' and v_table='todos' then
        if (v_row->>'user_id')::uuid is distinct from p_user_id then
          raise exception using errcode='42501',message='invalid_owner'; end if;
        v_resource := 'todo';
        perform private.mcp_check_links_v2(p_user_id,v_row);
      elsif v_op.tool_name='create_word_deck' and v_table='word_decks' then
        if (v_row->>'user_id')::uuid is distinct from p_user_id then
          raise exception using errcode='42501',message='invalid_owner'; end if;
        v_resource := 'word_deck';
        perform private.mcp_check_links_v2(p_user_id,v_row);
      elsif v_op.tool_name='add_word_entry' and v_table='word_entries' then
        v_parent := (v_row->>'deck_id')::uuid;
        if not exists(select 1 from public.word_decks d join public.word_deck_ai_access a
          on a.deck_id=d.id and a.user_id=p_user_id
          where d.id=v_parent and d.user_id=p_user_id and not d.is_system and a.can_create)
          then raise exception using errcode='42501',message='word_deck_permission_denied'; end if;
        if exists(select 1 from public.word_entries where deck_id=v_parent
          and normalized_word=v_row->>'normalized_word') then
          raise exception using errcode='23505',message='word_entry_exists'; end if;
        v_resource := 'word';
      else raise exception using errcode='42501',message='invalid_insert_command'; end if;
      v_row := private.mcp_insert_row_v2(v_table,v_row);
      v_resource_id := (v_row->>'id')::uuid;
      v_receipt := jsonb_build_object('kind','row','table',v_table,'row',v_row);
      if v_resource='word_deck' then
        insert into public.mcp_v2_user_actions(operation_id,user_id,kind,resource_id)
          values(v_op.id,p_user_id,'word_deck_access',v_resource_id);
      end if;
    elsif v_payload->>'kind'='todo_status' and v_op.tool_name='update_todo_status' then
      v_resource := 'todo'; v_resource_id := (v_op.arguments->>'todo_id')::uuid;
      select to_jsonb(t) into v_row from public.todos t
        where id=v_resource_id and user_id=p_user_id for update;
      if v_row is null then raise exception using errcode='42501',message='todo_not_owned'; end if;
      update public.todos set status=v_op.arguments->>'status',
        completed_at=case when v_op.arguments->>'status'='completed' then clock_timestamp() end,
        cancelled_at=case when v_op.arguments->>'status'='cancelled' then clock_timestamp() end
        where id=v_resource_id returning to_jsonb(todos.*) into v_row;
      v_receipt := jsonb_build_object('kind','row','table','todos','row',v_row);
    elsif v_payload->>'kind'='problem' and v_op.tool_name in ('create_problem','create_problem_from_images') then
      v_resource := 'problem'; v_problem := (v_payload->>'problem_id')::uuid;
      v_subject := (v_payload->>'subject_id')::uuid;
      if v_subject is null then
        select id into v_subject from public.subjects where user_id=p_user_id and name='未分类' limit 1;
        if v_subject is null then
          perform private.mcp_check_content_limit_v2(p_user_id,'subjects',null);
          insert into public.subjects(user_id,name) values(p_user_id,'未分类') returning id into v_subject;
        end if;
      end if;
      if not exists(select 1 from public.subjects where id=v_subject and user_id=p_user_id)
        then raise exception using errcode='42501',message='subject_not_owned'; end if;
      if exists(select 1 from public.problems where id=v_problem) then
        raise exception using errcode='55000',message='legacy_unverified';
      end if;
      perform private.mcp_check_content_limit_v2(p_user_id,'problems_per_subject',v_subject);
      perform private.mcp_check_assets_v2(p_user_id,coalesce(v_payload->'assets','[]'));
      insert into public.problems(id,user_id,subject_id,title,content,parts,status,is_optional,
        assets,solution_text,solution_assets,source)
      values(v_problem,p_user_id,v_subject,v_payload->>'title',v_payload->>'content',v_payload->'parts',
        'needs_review',false,coalesce(v_payload->'assets','[]'),coalesce(v_payload->>'solution_text',''),
        '[]',coalesce(v_payload->'source','{}')||jsonb_build_object('actor','mcp','mcp_contract_version','2.0.0',
          'mcp_request_id',v_op.request_id,'mcp_request_fingerprint',v_op.fingerprint,'mcp_operation_id',v_op.id))
        returning to_jsonb(problems.*) into v_row;
      for v_tag_name in select jsonb_array_elements_text(coalesce(v_payload->'tags','[]')) loop
        select id into v_tag from public.tags where user_id=p_user_id and subject_id=v_subject and name=v_tag_name limit 1;
        if v_tag is null then
          perform private.mcp_check_content_limit_v2(p_user_id,'tags_per_subject',v_subject);
          insert into public.tags(user_id,subject_id,name) values(p_user_id,v_subject,v_tag_name) returning id into v_tag;
        end if;
        insert into public.problem_tag(user_id,problem_id,tag_id) values(p_user_id,v_problem,v_tag)
          on conflict(problem_id,tag_id) do nothing;
      end loop;
      if v_payload->>'problem_set_id' is not null then
        if not exists(select 1 from public.problem_sets where id=(v_payload->>'problem_set_id')::uuid
          and user_id=p_user_id and subject_id=v_subject and not is_smart)
          then raise exception using errcode='42501',message='problem_set_not_owned_or_manual'; end if;
        insert into public.problem_set_problems(user_id,problem_set_id,problem_id)
          values(p_user_id,(v_payload->>'problem_set_id')::uuid,v_problem);
      end if;
      insert into public.review_schedule(user_id,problem_id,next_review_at,interval_days)
        values(p_user_id,v_problem,clock_timestamp(),1);
      if coalesce((v_payload->>'needs_images')::boolean,false) then
        insert into public.mcp_v2_user_actions(operation_id,user_id,kind,resource_id)
          values(v_op.id,p_user_id,'images',v_problem);
      end if;
      if v_op.arguments->>'initial_idea_draft' is not null then
        insert into public.problem_initial_idea_mcp_challenges(user_id,problem_id,source_api_token_id,
          source_oauth_token_id,source_request_id,proposed_idea,exact_text_hash,challenge_token_hash,expires_at)
        values(p_user_id,v_problem,v_op.credential_pat_id,v_op.credential_oauth_id,v_op.request_id,
          v_op.arguments->>'initial_idea_draft',
          encode(extensions.digest(convert_to(v_op.arguments->>'initial_idea_draft','UTF8'),'sha256'),'hex'),
          encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),clock_timestamp()+interval '10 minutes')
        returning id into v_challenge;
        insert into public.mcp_v2_user_actions(operation_id,user_id,kind,resource_id,challenge_id)
          values(v_op.id,p_user_id,'initial_idea',v_problem,v_challenge);
      end if;
      v_resource_id := v_problem;
      v_receipt := jsonb_build_object('kind','row','table','problems','row',v_row);
    else raise exception using errcode='42501',message='invalid_prepared_command'; end if;

    update public.mcp_v2_operations set state='committed',receipt=v_receipt,
      resource_type=v_resource,resource_id=v_resource_id,committed_at=clock_timestamp(),
      updated_at=clock_timestamp(),lease_token=null,lease_expires_at=null,error=null
      where id=v_op.id returning * into v_op;
  exception when others then
    get stacked diagnostics v_constraint=constraint_name,v_error_table=table_name,v_error_schema=schema_name;
    v_code := case when sqlerrm ~ '^[A-Za-z][A-Za-z0-9_]+$' then lower(sqlerrm) else 'database_error' end;
    v_retryable := sqlstate in ('40001','40P01','57014') or sqlstate like '08%'
      or v_code in ('credential_unavailable','notebook_permission_denied','word_deck_permission_denied');
    update public.mcp_v2_operations set state='failed',
      error=jsonb_build_object('code',v_code,'message','数据库事务未提交。','retryable',v_retryable),
      failure_diagnostic=jsonb_build_object('sqlstate',sqlstate,'constraint',v_constraint,'table',v_error_table,'schema',v_error_schema),
      lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
      where id=v_op.id returning * into v_op;
  end;
  return to_jsonb(v_op)||jsonb_build_object('replayed',false);
end;
$$;

revoke all on function public.begin_mcp_operation_v2(uuid,text,text,text,text,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.renew_mcp_operation_lease_v2(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.prepare_mcp_operation_v2(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fail_mcp_operation_v2(uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.commit_mcp_operation_v2(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_mcp_operation_v2(uuid,text,text,text,text,jsonb,text,uuid),
  public.renew_mcp_operation_lease_v2(uuid,uuid,uuid), public.prepare_mcp_operation_v2(uuid,uuid,uuid,jsonb),
  public.fail_mcp_operation_v2(uuid,uuid,uuid,text,boolean), public.commit_mcp_operation_v2(uuid,uuid,uuid) to service_role;
revoke all on function private.invoke_mcp_native_rpc_v2(text,uuid,jsonb),
  private.mcp_insert_row_v2(text,jsonb),private.mcp_v2_immutable_approval() from public,anon,authenticated;
