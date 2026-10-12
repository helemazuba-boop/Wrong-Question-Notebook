create table public.account_data_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  requested_by uuid not null,
  kind text not null check(kind in ('export','delete')),
  status text not null default 'pending' check(status in ('pending','running','completed','failed','cancelled')),
  attempts integer not null default 0,
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  archive_path text,
  last_error text
);
create unique index one_active_account_job on public.account_data_jobs(user_id) where status in ('pending','running');
alter table public.account_data_jobs enable row level security;
revoke all on public.account_data_jobs from public,anon,authenticated;
grant all on public.account_data_jobs to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('account-exports','account-exports',false,536870912) on conflict(id) do nothing;

create function public.enqueue_account_data_job(p_user_id uuid,p_actor_id uuid,p_kind text) returns uuid
language plpgsql security definer set search_path='' as $$
declare job_id uuid; existing_kind text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,12));
  if p_kind not in ('export','delete') then raise exception 'invalid_job_kind' using errcode='22023'; end if;
  if p_actor_id<>p_user_id and not exists(select 1 from public.user_profiles where id=p_actor_id and is_active and user_role='super_admin') then raise exception 'permission_denied' using errcode='42501'; end if;
  if not exists(select 1 from public.user_profiles where id=p_user_id) then raise exception 'account_not_found' using errcode='P0002'; end if;
  if p_kind='export' and not exists(select 1 from public.user_profiles where id=p_user_id and is_active) then raise exception 'account_inactive' using errcode='42501'; end if;
  if p_kind='delete' and exists(select 1 from public.user_profiles where id=p_user_id and user_role='super_admin') then raise exception 'transfer_super_admin_role_first' using errcode='42501'; end if;
  select id,kind into job_id,existing_kind from public.account_data_jobs where user_id=p_user_id and status in ('pending','running');
  if job_id is not null then
    if existing_kind=p_kind then return job_id; end if;
    raise exception 'account_job_in_progress' using errcode='40001';
  end if;
  insert into public.account_data_jobs(user_id,requested_by,kind) values(p_user_id,p_actor_id,p_kind) returning id into job_id;
  if p_kind='delete' then update public.user_profiles set is_active=false where id=p_user_id; end if;
  return job_id;
end $$;
create function public.claim_account_data_job() returns setof public.account_data_jobs
language sql security definer set search_path='' as $$
  with selected as (
    select id from public.account_data_jobs where (status='pending' and next_attempt_at<=now()) or (status='running' and lease_until<now())
    order by created_at,id for update skip locked limit 1
  ) update public.account_data_jobs j set status='running',lease_id=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempts=j.attempts+1
  from selected s where s.id=j.id returning j.*;
$$;

-- A single database snapshot is returned as one JSON value. The API's usual
-- row limit therefore cannot truncate a user's large table to 1000 records.
create function public.export_account_data(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb='{}'; rows jsonb; t record;
begin
  if not exists(select 1 from public.user_profiles where id=p_user_id and is_active) then raise exception 'account_inactive' using errcode='42501'; end if;
  for t in select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attname='user_id' and a.attnum>0 and not a.attisdropped)
    and c.relname not in ('account_data_jobs','oauth_authorization_codes','oauth_tokens','user_api_tokens','push_subscriptions','esp32_pairing_pending','qr_upload_sessions')
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r)-ARRAY[''token_hash'',''api_token_hash'',''access_token_hash'',''refresh_token_hash'',''secret'',''pairing_code'']),''[]''::jsonb) from public.%I r where user_id=$1',t.relname) into rows using p_user_id;
    result=result||jsonb_build_object(t.relname,rows);
  end loop;
  select coalesce(jsonb_agg(to_jsonb(p)),'[]') into rows from public.user_profiles p where id=p_user_id;
  result=result||jsonb_build_object('user_profiles',rows);
  select coalesce(jsonb_agg(to_jsonb(e)),'[]') into rows from public.word_entries e where e.deck_id in(select id from public.word_decks where user_id=p_user_id) or e.id in(select word_entry_id from public.word_progress where user_id=p_user_id);
  result=result||jsonb_build_object('word_entries',rows);
  select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from public.problem_set_shares s where shared_by_user_id=p_user_id;
  result=result||jsonb_build_object('problem_set_shares',rows);
  select coalesce(jsonb_agg(to_jsonb(r)),'[]') into rows from public.problem_set_reports r where reporter_user_id=p_user_id;
  result=result||jsonb_build_object('problem_set_reports',rows);
  select coalesce(jsonb_agg(to_jsonb(r)),'[]') into rows from public.review_session_results r where session_state_id in(select id from public.review_session_state where user_id=p_user_id);
  result=result||jsonb_build_object('review_session_results',rows);
  select coalesce(jsonb_agg(to_jsonb(r)-ARRAY['lease_id','lease_until']),'[]') into rows from public.todo_push_deliveries r where notification_id in(select id from public.todo_notifications where user_id=p_user_id);
  result=result||jsonb_build_object('todo_push_deliveries',rows);
  return result;
end $$;
create function public.account_storage_objects(p_user_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'path',name)),'[]') from storage.objects
  where owner_id=p_user_id::text or name like p_user_id::text||'/%' or name like 'user/'||p_user_id::text||'/%';
$$;
create function public.foreign_account_asset_owners(p_user_id uuid,p_path text) returns setof uuid
language sql security definer set search_path='' as $$
  select distinct user_id from public.problems where user_id<>p_user_id and (
    jsonb_path_exists(assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_path)) or
    jsonb_path_exists(solution_assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_path)))
  union select distinct user_id from public.notebook_notes where user_id<>p_user_id and jsonb_path_exists(assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_path));
$$;
create function public.replace_asset_reference(p_value jsonb,p_old text,p_new text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'string' then return case when p_value=to_jsonb(p_old) then to_jsonb(p_new) else p_value end;
    when 'array' then select coalesce(jsonb_agg(public.replace_asset_reference(value,p_old,p_new)),'[]') into result from jsonb_array_elements(p_value);return result;
    when 'object' then select coalesce(jsonb_object_agg(key,public.replace_asset_reference(value,p_old,p_new)),'{}') into result from jsonb_each(p_value);return result;
    else return p_value;
  end case;
end $$;
create function public.rehome_account_asset(p_owner_id uuid,p_recipient_id uuid,p_old text,p_new text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_owner_id=p_recipient_id or p_new not like 'user/'||p_recipient_id::text||'/retained/%' then raise exception 'invalid_asset_transfer' using errcode='22023'; end if;
  update public.problems set assets=public.replace_asset_reference(assets,p_old,p_new),solution_assets=public.replace_asset_reference(solution_assets,p_old,p_new)
    where user_id=p_recipient_id and (jsonb_path_exists(assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_old)) or jsonb_path_exists(solution_assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_old)));
  update public.notebook_notes set assets=public.replace_asset_reference(assets,p_old,p_new)
    where user_id=p_recipient_id and jsonb_path_exists(assets,'$.** ? (@ == $path)',jsonb_build_object('path',p_old));
end $$;
revoke all on function public.enqueue_account_data_job(uuid,uuid,text),public.claim_account_data_job(),public.export_account_data(uuid),public.account_storage_objects(uuid),public.foreign_account_asset_owners(uuid,text),public.replace_asset_reference(jsonb,text,text),public.rehome_account_asset(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_account_data_job(uuid,uuid,text),public.claim_account_data_job(),public.export_account_data(uuid),public.account_storage_objects(uuid),public.foreign_account_asset_owners(uuid,text),public.replace_asset_reference(jsonb,text,text),public.rehome_account_asset(uuid,uuid,text,text) to service_role;

-- Change-feed triggers create tombstones on content deletion. Delete their
-- source rows while the Auth parent still exists, then let Auth cascade the
-- remaining personal rows. Deleting Auth first violates the tombstone FK.
create function public.prepare_account_identity_deletion(p_user_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.account_data_jobs where user_id=p_user_id and kind='delete' and status='running') or exists(select 1 from public.user_profiles where id=p_user_id and is_active) then raise exception 'deletion_not_authorized' using errcode='42501'; end if;
  delete from public.notebooks where user_id=p_user_id;
  delete from public.word_decks where user_id=p_user_id;
  delete from public.word_progress where user_id=p_user_id;
  delete from public.subjects where user_id=p_user_id;
  delete from public.todos where user_id=p_user_id;
end $$;
revoke all on function public.prepare_account_identity_deletion(uuid) from public,anon,authenticated;
grant execute on function public.prepare_account_identity_deletion(uuid) to service_role;
