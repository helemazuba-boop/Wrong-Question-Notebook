-- Device voice reuses durable operation storage, with its own credential gate.
alter table public.mcp_v2_operations add column credential_device_id uuid references public.esp32_devices(id) on delete set null;
alter table public.mcp_v2_operations add constraint mcp_v2_operations_one_credential
  check(num_nonnulls(credential_pat_id,credential_oauth_id,credential_device_id)<=1);

create function public.begin_mcp_voice_operation_v1(p_user_id uuid,p_device_id uuid,p_tool_name text,
  p_request_id text,p_fingerprint text,p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op public.mcp_v2_operations%rowtype;
begin
  if not exists(select 1 from public.esp32_devices d join public.user_profiles p on p.id=d.user_id
    where d.id=p_device_id and d.user_id=p_user_id and p.is_active) then
    raise exception using errcode='42501',message='device_context_mismatch'; end if;
  if p_tool_name not in ('create_todo','create_notebook_note','update_todo_status') then
    raise exception using errcode='42501',message='voice_write_not_allowed'; end if;
  insert into public.mcp_v2_operations(user_id,tool_name,operation_kind,request_id,fingerprint,arguments,credential_device_id)
    values(p_user_id,p_tool_name,'voice:'||p_tool_name,p_request_id,p_fingerprint,p_arguments,p_device_id)
    on conflict(user_id,request_id) do nothing;
  select * into strict v_op from public.mcp_v2_operations where user_id=p_user_id and request_id=p_request_id for update;
  if v_op.fingerprint<>p_fingerprint or v_op.credential_device_id is distinct from p_device_id
    or v_op.tool_name<>p_tool_name then raise exception using errcode='22023',message='request_id_reused'; end if;
  if v_op.state='committed' then return to_jsonb(v_op)||jsonb_build_object('claimed',false); end if;
  if v_op.recover_until<=clock_timestamp() then raise exception using errcode='55000',message='resume_expired'; end if;
  if v_op.state='failed' and not coalesce((v_op.error->>'retryable')::boolean,false) then return to_jsonb(v_op)||jsonb_build_object('claimed',false); end if;
  if v_op.lease_expires_at>clock_timestamp() then return to_jsonb(v_op)||jsonb_build_object('claimed',false); end if;
  update public.mcp_v2_operations set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',
    state=case when prepared is null then 'preparing' else 'prepared' end,error=null,updated_at=clock_timestamp()
    where id=v_op.id returning * into v_op;
  return to_jsonb(v_op)||jsonb_build_object('claimed',true);
end;
$$;

create function public.commit_mcp_voice_operation_v1(p_user_id uuid,p_operation_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op public.mcp_v2_operations%rowtype;v_row jsonb;v_resource text;v_id uuid;v_parent uuid;
  v_code text;v_sqlstate text;
begin
  select * into strict v_op from public.mcp_v2_operations where id=p_operation_id and user_id=p_user_id for update;
  if not exists(select 1 from public.esp32_devices d join public.user_profiles p on p.id=d.user_id
    where d.id=v_op.credential_device_id and d.user_id=p_user_id and p.is_active)
    or v_op.operation_kind is distinct from 'voice:'||v_op.tool_name then
    raise exception using errcode='42501',message='device_context_mismatch'; end if;
  if v_op.tool_name='create_notebook_note' then
    v_parent:=(v_op.arguments->>'notebook_id')::uuid;
    if not exists(select 1 from public.notebooks n join public.notebook_ai_access a on a.notebook_id=n.id and a.user_id=p_user_id
      where n.id=v_parent and n.user_id=p_user_id and n.archived_at is null and a.can_create) then
      raise exception using errcode='42501',message='notebook_permission_denied'; end if;
  end if;
  if v_op.state='committed' then return to_jsonb(v_op)||jsonb_build_object('replayed',true); end if;
  if v_op.state<>'prepared' or v_op.lease_token is distinct from p_lease_token or v_op.lease_expires_at<=clock_timestamp()
    or v_op.recover_until<=clock_timestamp() then raise exception using errcode='55000',message='operation_lease_lost'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||p_user_id,0));
  begin
    if v_op.tool_name in ('create_todo','create_notebook_note') then
      v_resource:=case when v_op.tool_name='create_todo' then 'todo' else 'note' end;
      v_row:=v_op.prepared->'row';
      if v_op.prepared->>'kind'<>'insert' or v_op.prepared->>'table' is distinct from
        (case when v_resource='todo' then 'todos' else 'notebook_notes' end)
        or (v_row->>'user_id')::uuid is distinct from p_user_id then
        raise exception using errcode='42501',message='invalid_voice_command'; end if;
      if v_resource='note' and (v_row->>'notebook_id')::uuid is distinct from v_parent then
        raise exception using errcode='42501',message='notebook_permission_denied'; end if;
      if v_resource='todo' and ((v_row->>'source_device_id')::uuid is distinct from v_op.credential_device_id
        or v_row ? 'word_deck_id' or v_row ? 'word_entry_id') then
        raise exception using errcode='42501',message='invalid_voice_command'; end if;
      perform private.mcp_check_links_v2(p_user_id,v_row);
      v_row:=private.mcp_insert_row_v2(v_op.prepared->>'table',v_row);v_id:=(v_row->>'id')::uuid;
    elsif v_op.tool_name='update_todo_status' and v_op.prepared->>'kind'='todo_status' then
      v_resource:='todo';v_id:=(v_op.arguments->>'todo_id')::uuid;
      if v_op.arguments->>'status' not in ('pending','completed','cancelled') then
        raise exception using errcode='22023',message='invalid_status'; end if;
      select to_jsonb(t) into v_row from public.todos t where id=v_id and user_id=p_user_id for update;
      if v_row is null then raise exception using errcode='42501',message='todo_not_owned'; end if;
      update public.todos set status=v_op.arguments->>'status',
        completed_at=case when v_op.arguments->>'status'='completed' then clock_timestamp() end,
        cancelled_at=case when v_op.arguments->>'status'='cancelled' then clock_timestamp() end
        where id=v_id returning to_jsonb(todos.*) into v_row;
    else raise exception using errcode='42501',message='voice_write_not_allowed'; end if;
    update public.mcp_v2_operations set state='committed',resource_type=v_resource,resource_id=v_id,
      receipt=jsonb_build_object('kind','row','row',v_row),committed_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_token=null,lease_expires_at=null where id=v_op.id returning * into v_op;
  exception when others then
    get stacked diagnostics v_sqlstate=returned_sqlstate,v_code=message_text;
    update public.mcp_v2_operations set state='failed',error=jsonb_build_object('code',
      case when v_code~'^[a-z][a-z0-9_]+$' then v_code else 'voice_write_failed' end,
      'message','语音写入尚未提交。','retryable',v_sqlstate in ('40001','40P01','55P03','57014')),
      failure_diagnostic=jsonb_build_object('sqlstate',v_sqlstate),lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
      where id=v_op.id returning * into v_op;
  end;
  return to_jsonb(v_op)||jsonb_build_object('replayed',false);
end;
$$;
revoke all on function public.begin_mcp_voice_operation_v1(uuid,uuid,text,text,text,jsonb),
  public.commit_mcp_voice_operation_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_mcp_voice_operation_v1(uuid,uuid,text,text,text,jsonb),
  public.commit_mcp_voice_operation_v1(uuid,uuid,uuid) to service_role;
