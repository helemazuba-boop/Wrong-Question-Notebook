-- Only run in a disposable schema copy. The caller wraps this in a transaction
-- and rolls it back. No storage/model requests are made.
do $$
declare
  u uuid := '10000000-0000-4000-8000-000000000001';
  v uuid := '10000000-0000-4000-8000-000000000002';
  s uuid := '30000000-0000-4000-8000-000000000001';
  a uuid := '20000000-0000-4000-8000-000000000001';
  b uuid := '20000000-0000-4000-8000-000000000002';
  c uuid := '20000000-0000-4000-8000-000000000003';
  n uuid := '40000000-0000-4000-8000-000000000001';
  p uuid := '50000000-0000-4000-8000-000000000001';
  t uuid := '60000000-0000-4000-8000-000000000001';
  h text;
  r bigint;
  r2 bigint;
begin
  if has_table_privilege('anon','public.device_pack_summaries','select')
     or has_table_privilege('authenticated','public.device_pack_summaries','select')
     or has_table_privilege('authenticated','public.device_pack_summaries','insert')
     or has_function_privilege('anon','public.device_note_pack_sources_v1(uuid)','execute')
     or has_function_privilege('authenticated','public.device_note_pack_sources_v1(uuid)','execute')
  then raise exception 'derived manifest data exposed to an unprivileged role'; end if;
  if not has_function_privilege('service_role','public.device_note_pack_sources_v1(uuid)','execute')
     or not has_table_privilege('service_role','public.device_pack_summaries','insert')
  then raise exception 'service role cannot materialize'; end if;

  insert into auth.users(id,email) values(u,'manifest-a@example.invalid'),(v,'manifest-b@example.invalid');
  insert into public.subjects(id,user_id,name) values(s,u,'Manifest');
  insert into public.notebooks(id,user_id,subject_id,title) values
    (a,u,s,'A'),(b,u,s,'B'),(c,v,s,'Private');
  insert into public.notebook_notes(id,user_id,notebook_id,title,content,sort_index)
    values(n,u,a,'Note','body',1);
  if (select count(*) from public.device_note_pack_sources_v1(u)) <> 2
     or (select count(*) from public.device_note_pack_sources_v1(v)) <> 1
  then raise exception 'source RPC crossed ownership boundary'; end if;

  select source_key into h from public.device_note_pack_sources_v1(u) where id=a;
  update public.notebook_notes set content='changed' where id=n;
  if h=(select source_key from public.device_note_pack_sources_v1(u) where id=a)
  then raise exception 'note content did not invalidate'; end if;
  select source_key into h from public.device_note_pack_sources_v1(u) where id=a;
  update public.notebook_notes set notebook_id=b where id=n;
  if h=(select source_key from public.device_note_pack_sources_v1(u) where id=a)
  then raise exception 'move out did not invalidate the source notebook'; end if;
  select source_key into h from public.device_note_pack_sources_v1(u) where id=b;
  update public.notebooks set title='Renamed' where id=b;
  if h<>(select source_key from public.device_note_pack_sources_v1(u) where id=b)
     or 'Renamed'<>(select title from public.device_note_pack_sources_v1(u) where id=b)
  then raise exception 'title edit rebuilt content or was hidden'; end if;
  update public.notebooks set archived_at=now() where id=a;
  if exists(select 1 from public.device_note_pack_sources_v1(u) where id=a)
  then raise exception 'archived notebook stayed visible'; end if;

  insert into public.problems(id,user_id,subject_id,title,status,parts)
    values(p,u,s,'Problem','wrong','[{"index":1,"type":"essay","full_marks":1,"content":"fixture"}]');
  insert into public.tags(id,user_id,subject_id,name) values(t,u,s,'Tag');
  select revision into r from public.device_content_revisions where scope_key=u::text and domain='problem_packs';
  insert into public.problem_tag(user_id,problem_id,tag_id) values(u,p,t);
  select revision into r2 from public.device_content_revisions where scope_key=u::text and domain='problem_packs';
  if r2<=r then raise exception 'tag attachment did not invalidate'; end if;
  delete from public.problem_tag where problem_id=p and tag_id=t;
  if r2 >= (select revision from public.device_content_revisions where scope_key=u::text and domain='problem_packs')
  then raise exception 'tag detachment did not invalidate'; end if;

  insert into public.device_pack_artifacts(user_id,domain,logical_id,revision,sha256,storage_path,byte_size)
    values(u,'note_packs',b,1,repeat('a',64),'fixture-pack',12);
  insert into public.device_pack_summaries(user_id,domain,logical_id,source_key,sha256,pack_revision,entry_count,byte_size)
    values(u,'note_packs',b,repeat('1',64),repeat('a',64),1,1,12);
  select revision into r from public.device_content_revisions where scope_key=u::text and domain='note_packs';
  delete from public.device_pack_artifacts where user_id=u and sha256=repeat('a',64);
  if exists(select 1 from public.device_pack_summaries where user_id=u)
     or r >= (select revision from public.device_content_revisions where scope_key=u::text and domain='note_packs')
  then raise exception 'pack removal did not invalidate'; end if;

  insert into public.device_pack_artifacts(user_id,domain,logical_id,revision,sha256,storage_path,byte_size)
    values(u,'note_packs',b,1,repeat('a',64),'fixture-pack',12);
  insert into public.device_pack_summaries(user_id,domain,logical_id,source_key,sha256,pack_revision,entry_count,byte_size)
    values(u,'note_packs',b,repeat('1',64),repeat('a',64),1,1,12);
  insert into public.device_image_artifacts(user_id,image_id,pixel_format,storage_path)
    values(u,repeat('b',64),'bw1','fixture-image');
  select source_key into h from public.device_note_pack_sources_v1(u) where id=b;
  select revision into r from public.device_content_revisions where scope_key=u::text and domain='problem_packs';
  delete from public.device_image_artifacts where user_id=u;
  if exists(select 1 from public.device_pack_summaries where user_id=u)
     or r >= (select revision from public.device_content_revisions where scope_key=u::text and domain='problem_packs')
     or h=(select source_key from public.device_note_pack_sources_v1(u) where id=b)
  then raise exception 'image removal did not invalidate'; end if;

  select revision into r from public.device_content_revisions where scope_key=u::text and domain='note_packs';
  select revision into r2 from public.device_content_revisions where scope_key=v::text and domain='note_packs';
  update public.notebooks set user_id=v where id=b;
  if r >= (select revision from public.device_content_revisions where scope_key=u::text and domain='note_packs')
     or r2 >= (select revision from public.device_content_revisions where scope_key=v::text and domain='note_packs')
  then raise exception 'ownership change did not invalidate both owners'; end if;
  raise notice 'manifest PostgreSQL contract passed: source heads, tag/owner/artifact invalidation, service-only grants';
end;
$$;
