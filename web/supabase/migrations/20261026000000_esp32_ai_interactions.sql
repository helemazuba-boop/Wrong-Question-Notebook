-- Device decisions are distinct from MCP edit-proposal approvals. No business
-- row is written by these functions; the voice executor commits only after an
-- answered, identity-bound decision. Pending decisions fail closed on timeout.
create table public.esp32_ai_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.esp32_devices(id) on delete cascade,
  request_id text not null check(length(request_id) between 1 and 128),
  call_id text not null check(length(call_id) between 1 and 128),
  fingerprint text not null,
  payload jsonb not null,
  state text not null default 'pending' check(state in ('pending','answered','cancelled')),
  answer text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(user_id,device_id,request_id,call_id)
);
alter table public.esp32_ai_interactions enable row level security;
revoke all on public.esp32_ai_interactions from public,anon,authenticated;
grant all on public.esp32_ai_interactions to service_role;

create function public.begin_esp32_ai_interaction_v1(
  p_user_id uuid,p_device_id uuid,p_request_id text,p_call_id text,
  p_payload jsonb,p_fingerprint text,p_timeout_ms integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.esp32_ai_interactions%rowtype;
begin
  if not exists(select 1 from public.esp32_devices d join public.user_profiles p on p.id=d.user_id
    where d.id=p_device_id and d.user_id=p_user_id and p.is_active) then
    raise exception using errcode='42501',message='device_context_mismatch'; end if;
  if p_payload->>'kind' not in ('question','write') or jsonb_typeof(p_payload->'options')<>'array'
    or jsonb_array_length(p_payload->'options') not between 1 and 8
    or p_timeout_ms not between 1 and 300000 then
    raise exception using errcode='22023',message='invalid_interaction'; end if;
  insert into public.esp32_ai_interactions(user_id,device_id,request_id,call_id,payload,fingerprint,expires_at)
    values(p_user_id,p_device_id,p_request_id,p_call_id,p_payload,p_fingerprint,
      clock_timestamp()+p_timeout_ms*interval '1 millisecond')
    on conflict(user_id,device_id,request_id,call_id) do nothing;
  select * into strict v from public.esp32_ai_interactions where user_id=p_user_id and device_id=p_device_id
    and request_id=p_request_id and call_id=p_call_id;
  if v.fingerprint<>p_fingerprint then
    raise exception using errcode='22023',message='request_id_reused'; end if;
  return to_jsonb(v);
end;
$$;

create function public.reply_esp32_ai_interaction_v1(p_user_id uuid,p_device_id uuid,p_id uuid,p_answer text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.esp32_ai_interactions%rowtype;
begin
  if not exists(select 1 from public.esp32_devices d join public.user_profiles p on p.id=d.user_id
    where d.id=p_device_id and d.user_id=p_user_id and p.is_active) then
    raise exception using errcode='42501',message='device_context_mismatch'; end if;
  select * into strict v from public.esp32_ai_interactions
    where id=p_id and user_id=p_user_id and device_id=p_device_id for update;
  if v.state='answered' and v.answer=p_answer then return to_jsonb(v); end if;
  if v.state<>'pending' or v.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',message='interaction_expired'; end if;
  if not exists(select 1 from jsonb_array_elements(v.payload->'options') o where o->>'value'=p_answer)
    and not (p_answer='__custom__' and coalesce((v.payload->>'allow_custom')::boolean,false)) then
    raise exception using errcode='22023',message='invalid_answer'; end if;
  update public.esp32_ai_interactions set state='answered',answer=p_answer where id=p_id returning * into v;
  return to_jsonb(v);
end;
$$;
revoke all on function public.begin_esp32_ai_interaction_v1(uuid,uuid,text,text,jsonb,text,integer),
  public.reply_esp32_ai_interaction_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.begin_esp32_ai_interaction_v1(uuid,uuid,text,text,jsonb,text,integer),
  public.reply_esp32_ai_interaction_v1(uuid,uuid,uuid,text) to service_role;
