-- Serialize credential creation with account deactivation. A credential
-- created first is revoked by the deactivation trigger; one created later
-- sees the inactive profile and cannot be minted.
create function public.guard_active_credential_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare active boolean;
begin
  select is_active into active from public.user_profiles where id=new.user_id for share;
  if active is distinct from true then raise exception 'account_inactive' using errcode='42501'; end if;
  return new;
end $$;
create trigger active_oauth_token_owner before insert on public.oauth_tokens for each row execute function public.guard_active_credential_owner();
create trigger active_pat_owner before insert on public.user_api_tokens for each row execute function public.guard_active_credential_owner();
create trigger active_oauth_code_owner before insert on public.oauth_authorization_codes for each row execute function public.guard_active_credential_owner();
create or replace function public.revoke_disabled_account_credentials()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.is_active and not new.is_active then
    update public.user_api_tokens set revoked_at=now() where user_id=new.id and revoked_at is null;
    update public.oauth_tokens set revoked_at=now() where user_id=new.id and revoked_at is null;
    update public.oauth_authorization_codes set used_at=now() where user_id=new.id and used_at is null;
  end if;
  return new;
end $$;
revoke all on function public.guard_active_credential_owner() from public,anon,authenticated;

-- Include owned resources whose child tables have no user_id column, such
-- as problem annotations and vocabulary pack metadata. Traverse only public
-- FK children without their own account owner; never pull other users' rows
-- merely because they refer to this user's shared content.
create function public.export_account_complete_data(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; rows jsonb; t record; fk record; predicate text; clause text; changed boolean;
begin
  result=public.export_account_data(p_user_id)-'problem_initial_idea_mcp_challenges';
  loop
    changed=false;
    for t in select c.oid,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r'
      and not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attname in ('user_id','reporter_user_id','shared_by_user_id') and a.attnum>0 and not a.attisdropped)
      and c.relname not in ('user_profiles','admin_settings','device_claims','oauth_clients','word_entries')
    loop
      predicate='';
      for fk in select k.conkey,k.confkey,k.confrelid,parent.relname parent_name from pg_catalog.pg_constraint k
        join pg_catalog.pg_class parent on parent.oid=k.confrelid join pg_catalog.pg_namespace n on n.oid=parent.relnamespace
        where k.contype='f' and k.conrelid=t.oid and n.nspname='public' and result ? parent.relname
      loop
        select string_agg(format('to_jsonb(r.%I)=p.value->%L',child.attname,parent.attname),' and ')
          into clause from unnest(fk.conkey,fk.confkey) as pairs(child_num,parent_num)
          join pg_catalog.pg_attribute child on child.attrelid=t.oid and child.attnum=pairs.child_num
          join pg_catalog.pg_attribute parent on parent.attrelid=fk.confrelid and parent.attnum=pairs.parent_num;
        predicate=predicate||case when predicate='' then '' else ' or ' end||format('exists(select 1 from jsonb_array_elements($1->%L) p(value) where %s)',fk.parent_name,clause);
      end loop;
      if predicate='' then continue; end if;
      execute format('select coalesce(jsonb_agg(to_jsonb(r)-ARRAY[''lease_token'',''lease_id'',''lease_until'']),''[]''::jsonb) from public.%I r where %s',t.relname,predicate) into rows using result;
      if rows is distinct from result->t.relname then result=result||jsonb_build_object(t.relname,rows);changed=true;end if;
    end loop;
    exit when not changed;
  end loop;
  result=jsonb_set(result,'{esp32_devices}',coalesce((select jsonb_agg(value-'flash_session_id'-'flash_session_expires_at') from jsonb_array_elements(result->'esp32_devices')),'[]'));
  return result;
end $$;
create or replace function public.account_storage_objects(p_user_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'path',name)),'[]') from storage.objects o
  where owner_id=p_user_id::text or name like p_user_id::text||'/%' or name like 'user/'||p_user_id::text||'/%'
    or (bucket_id='word-packs' and exists(select 1 from public.word_packs p join public.word_decks d on d.id=p.deck_id where d.user_id=p_user_id and p.storage_path=o.name));
$$;
revoke all on function public.export_account_complete_data(uuid) from public,anon,authenticated;
grant execute on function public.export_account_complete_data(uuid) to service_role;

create or replace function public.claim_account_data_job() returns setof public.account_data_jobs
language plpgsql security definer set search_path='' as $$
begin
  update public.account_data_jobs set status='failed',lease_until=null,last_error='Account export exceeded the worker time budget'
    where kind='export' and status='running' and lease_until<now() and attempts>=3;
  return query with selected as (
    select id from public.account_data_jobs where (status='pending' and next_attempt_at<=now()) or (status='running' and lease_until<now())
    order by created_at,id for update skip locked limit 1
  ) update public.account_data_jobs j set status='running',lease_id=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempts=j.attempts+1
    from selected s where s.id=j.id returning j.*;
end $$;
