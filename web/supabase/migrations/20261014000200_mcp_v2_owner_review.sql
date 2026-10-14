-- Cookie-authenticated owner controls. None are callable by an MCP credential.
create function private.mcp_check_content_limit_v2(p_user uuid,p_type text,p_subject uuid)
returns void language plpgsql set search_path='' as $$
declare v_limit bigint;v_count bigint;
begin
  select limit_value into v_limit from public.content_limit_overrides where user_id=p_user and resource_type=p_type;
  v_limit:=coalesce(v_limit,case p_type when 'subjects' then 6 when 'tags_per_subject' then 50 when 'problems_per_subject' then 300 end);
  if p_type='subjects' then select count(*) into v_count from public.subjects where user_id=p_user;
  elsif p_type='tags_per_subject' then select count(*) into v_count from public.tags where user_id=p_user and subject_id=p_subject;
  elsif p_type='problems_per_subject' then select count(*) into v_count from public.problems where user_id=p_user and subject_id=p_subject;
  else raise exception using errcode='22023',message='invalid_content_limit_type'; end if;
  if v_count>=v_limit then raise exception using errcode='23514',message='content_limit_reached'; end if;
end;
$$;

create function private.mcp_resource_snapshot_v2(p_user uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql set search_path='' as $$
declare v_row jsonb; v_idea jsonb;
begin
  if p_kind='problem' then
    select to_jsonb(p) into v_row from public.problems p where p.id=p_id and p.user_id=p_user for update;
    select jsonb_build_object('initial_idea',r.idea,'initial_idea_revision',r.revision)
      into v_idea from public.problem_user_contexts c join public.problem_initial_idea_revisions r
      on r.id=c.current_initial_idea_revision_id where c.user_id=p_user and c.problem_id=p_id;
    v_row := v_row || coalesce(v_idea,jsonb_build_object('initial_idea',null,'initial_idea_revision',0));
    v_row := v_row || jsonb_build_object('tag_ids',coalesce((select jsonb_agg(tag_id order by tag_id)
      from public.problem_tag where user_id=p_user and problem_id=p_id),'[]'::jsonb));
    v_row := v_row || jsonb_build_object('exam_source',jsonb_build_object('year',v_row->'source'->'year',
      'paper',v_row->'source'->'paper','question_no',v_row->'source'->'question_no','exam_type',v_row->'source'->'exam_type'),
      'tags',coalesce((select jsonb_agg(t.name order by t.name) from public.problem_tag pt join public.tags t on t.id=pt.tag_id
        where pt.user_id=p_user and pt.problem_id=p_id),'[]'::jsonb));
  elsif p_kind='note' then
    select to_jsonb(n) into v_row from public.notebook_notes n join public.notebooks b on b.id=n.notebook_id
      where n.id=p_id and n.user_id=p_user and b.user_id=p_user and b.archived_at is null and n.archived_at is null for update of n;
  elsif p_kind='word' then
    select to_jsonb(e) into v_row from public.word_entries e join public.word_decks d on d.id=e.deck_id
      where e.id=p_id and d.user_id=p_user and not d.is_system and d.is_active for update of e;
  elsif p_kind='todo' then
    select to_jsonb(t) into v_row from public.todos t where id=p_id and user_id=p_user for update;
  end if;
  if v_row is null then raise exception using errcode='42501',message='resource_not_owned'; end if;
  return v_row;
end;
$$;

create function private.mcp_check_links_v2(p_user uuid,p_changes jsonb)
returns void language plpgsql set search_path='' as $$
declare v_key text; v_table text; v_owned boolean; v_id uuid;
begin
  for v_key,v_table in select * from (values ('subject_id','subjects'),('problem_id','problems'),
    ('linked_problem_id','problems'),('problem_set_id','problem_sets'),('notebook_id','notebooks'),
    ('note_id','notebook_notes'),('word_deck_id','word_decks')) m(k,t) loop
    v_id := (p_changes->>v_key)::uuid;
    if v_id is null then continue; end if;
    execute format('select exists(select 1 from public.%I where id=$1 and user_id=$2)',v_table)
      into v_owned using v_id,p_user;
    if not v_owned then raise exception using errcode='42501',message='linked_resource_not_owned'; end if;
  end loop;
  v_id := (p_changes->>'word_entry_id')::uuid;
  if v_id is not null and not exists(select 1 from public.word_entries e join public.word_decks d on d.id=e.deck_id
    where e.id=v_id and d.user_id=p_user and (p_changes->>'word_deck_id' is null or e.deck_id=(p_changes->>'word_deck_id')::uuid))
    then raise exception using errcode='42501',message='linked_word_not_owned'; end if;
end;
$$;

create function private.mcp_check_assets_v2(p_user uuid,p_assets jsonb)
returns void language plpgsql set search_path='' as $$
declare v_asset jsonb; v_key text; v_path text;
begin
  if jsonb_typeof(p_assets)<>'array' or jsonb_array_length(p_assets)>100 then
    raise exception using errcode='22023',message='invalid_assets'; end if;
  for v_asset in select jsonb_array_elements(p_assets) loop
    for v_key in select unnest(array['path','display_path','preview_path','gray4_display_path','gray4_preview_path']) loop
      v_path := v_asset->>v_key;
      if v_key<>'path' and v_path is null then continue; end if;
      if v_path is null or left(v_path,length('user/'||p_user||'/')) <> 'user/'||p_user||'/'
        or v_path like '%/../%' or v_path like '%\\%' or not exists(
          select 1 from storage.objects where bucket_id='problem-uploads' and name=v_path
        ) then raise exception using errcode='42501',message='asset_not_owned_or_missing'; end if;
    end loop;
  end loop;
end;
$$;

create function public.propose_mcp_update_v2(p_user_id uuid,p_operation_id uuid,p_lease_token uuid,
  p_resource_type text,p_resource_id uuid,p_changes jsonb,p_expected_revision bigint,p_expected_idea_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op public.mcp_v2_operations%rowtype; v_before jsonb;
begin
  select * into strict v_op from public.mcp_v2_operations where id=p_operation_id and user_id=p_user_id for update;
  if v_op.state in ('awaiting_approval','committed','rejected') then return to_jsonb(v_op); end if;
  if v_op.lease_token is distinct from p_lease_token or v_op.lease_expires_at<=clock_timestamp()
    or v_op.recover_until<=clock_timestamp() then raise exception using errcode='55000',message='operation_lease_lost'; end if;
  if p_resource_type is distinct from (case v_op.tool_name when 'submit_problem_update' then 'problem'
    when 'update_notebook_note' then 'note' when 'update_word_entry' then 'word' when 'update_todo' then 'todo' end)
    or p_changes='{}'::jsonb then raise exception using errcode='22023',message='invalid_proposal'; end if;
  v_before := private.mcp_resource_snapshot_v2(p_user_id,p_resource_type,p_resource_id);
  if (v_before->>'revision')::bigint<>p_expected_revision
    or (p_changes ? 'initial_idea' and coalesce((v_before->>'initial_idea_revision')::bigint,0)
      is distinct from coalesce(p_expected_idea_revision,0)) then
    raise exception using errcode='40001',message='revision_conflict'; end if;
  update public.mcp_v2_operations set state='awaiting_approval',resource_type=p_resource_type,
    resource_id=p_resource_id,expected_revision=p_expected_revision,expected_idea_revision=p_expected_idea_revision,
    prepared=jsonb_build_object('kind','proposal','changes',p_changes),lease_token=null,lease_expires_at=null,
    updated_at=clock_timestamp() where id=v_op.id returning * into v_op;
  return to_jsonb(v_op);
end;
$$;

create function private.mcp_set_initial_idea_v2(p_user uuid,p_problem uuid,p_idea text)
returns uuid language plpgsql set search_path='' as $$
declare v_head uuid; v_revision bigint; v_id uuid;
begin
  insert into public.problem_user_contexts(user_id,problem_id) values(p_user,p_problem) on conflict do nothing;
  select current_initial_idea_revision_id into v_head from public.problem_user_contexts
    where user_id=p_user and problem_id=p_problem for update;
  select revision into v_revision from public.problem_initial_idea_revisions where id=v_head;
  insert into public.problem_initial_idea_revisions(user_id,problem_id,revision,revision_kind,idea,channel_source,idea_origin)
    values(p_user,p_problem,coalesce(v_revision,0)+1,case when p_idea is null then 'clear' else 'set' end,
      p_idea,'mcp','user_confirmed_external') returning id into v_id;
  update public.problem_user_contexts set current_initial_idea_revision_id=v_id,updated_at=clock_timestamp()
    where user_id=p_user and problem_id=p_problem;
  return v_id;
end;
$$;

-- Fixed editable-column lists; ids, owner, revision and system provenance cannot be submitted.
create function private.mcp_apply_changes_v2(p_user uuid,p_kind text,p_id uuid,p_changes jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_allowed text[]; v_table text; v_patch jsonb:=p_changes; v_key text; v_assign text;
  v_before jsonb; v_subject uuid; v_tag uuid; v_name text; v_idea uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||p_user,0));
  v_before := private.mcp_resource_snapshot_v2(p_user,p_kind,p_id);
  perform private.mcp_check_links_v2(p_user,p_changes);
  if p_kind='problem' then
    v_table:='problems'; v_allowed:=array['title','content','subject_id','parts','solution_text','assets','solution_assets','tag_ids','tags','initial_idea','exam_source','is_optional','status'];
    if v_patch ? 'assets' then perform private.mcp_check_assets_v2(p_user,v_patch->'assets'); end if;
    if v_patch ? 'solution_assets' then perform private.mcp_check_assets_v2(p_user,v_patch->'solution_assets'); end if;
    v_subject:=coalesce((v_patch->>'subject_id')::uuid,(v_before->>'subject_id')::uuid);
    if v_subject is distinct from (v_before->>'subject_id')::uuid and (
      exists(select 1 from public.problem_set_problems m join public.problem_sets s on s.id=m.problem_set_id where m.problem_id=p_id and s.subject_id<>v_subject)
      or (not v_patch ? 'tag_ids' and not v_patch ? 'tags' and jsonb_array_length(v_before->'tag_ids')>0)) then
      raise exception using errcode='22023',message='subject_links_require_review'; end if;
    if v_patch ? 'tag_ids' or v_patch ? 'tags' then
      delete from public.problem_tag where user_id=p_user and problem_id=p_id;
      for v_tag in select jsonb_array_elements_text(coalesce(v_patch->'tag_ids','[]'))::uuid loop
        if not exists(select 1 from public.tags where id=v_tag and user_id=p_user and subject_id=v_subject)
          then raise exception using errcode='42501',message='tag_not_owned_or_subject_mismatch'; end if;
        insert into public.problem_tag(user_id,problem_id,tag_id) values(p_user,p_id,v_tag) on conflict do nothing;
      end loop;
      for v_name in select jsonb_array_elements_text(coalesce(v_patch->'tags','[]')) loop
        select id into v_tag from public.tags where user_id=p_user and subject_id=v_subject and name=v_name limit 1;
        if v_tag is null then
          perform private.mcp_check_content_limit_v2(p_user,'tags_per_subject',v_subject);
          insert into public.tags(user_id,subject_id,name) values(p_user,v_subject,v_name) returning id into v_tag;
        end if;
        insert into public.problem_tag(user_id,problem_id,tag_id) values(p_user,p_id,v_tag) on conflict do nothing;
      end loop;
    end if;
    if v_patch ? 'initial_idea' then v_idea:=private.mcp_set_initial_idea_v2(p_user,p_id,v_patch->>'initial_idea'); end if;
    v_patch:=v_patch-'tag_ids'-'tags'-'initial_idea'-'exam_source';
    v_patch:=v_patch||jsonb_build_object('source',jsonb_strip_nulls(coalesce(v_before->'source','{}')||coalesce(p_changes->'exam_source','{}')||jsonb_build_object(
      'mcp_v2_last_edit',jsonb_build_object('origin','ai_proposed_user_approved','approved_at',clock_timestamp()))
      ||case when p_changes ? 'parts' then jsonb_build_object('answer_origin','ai_proposed_user_approved') else '{}'::jsonb end
      ||case when p_changes ? 'solution_text' then jsonb_build_object('solution_origin','ai_proposed_user_approved') else '{}'::jsonb end));
    v_patch:=jsonb_set(v_patch,'{solution_text}',coalesce(nullif(v_patch->'solution_text','null'),'""'));
    if not p_changes ? 'solution_text' then v_patch:=v_patch-'solution_text'; end if;
  elsif p_kind='note' then
    v_table:='notebook_notes';v_allowed:=array['title','content','linked_problem_id'];
    v_patch:=v_patch||jsonb_build_object('revision',(v_before->>'revision')::bigint+1);
  elsif p_kind='word' then
    v_table:='word_entries';v_allowed:=array['word','meaning','phonetic','example','example_translation','part_of_speech','tags'];
    if v_patch ? 'word' then v_patch:=v_patch||jsonb_build_object('normalized_word',lower(btrim(v_patch->>'word'))); end if;
    v_patch:=v_patch||jsonb_build_object('revision',(v_before->>'revision')::bigint+1);
  elsif p_kind='todo' then
    v_table:='todos';v_allowed:=array['title','description','priority','due_at','reminder_at','subject_id','problem_set_id','problem_id','notebook_id','note_id','word_deck_id','word_entry_id'];
  else raise exception using errcode='22023',message='invalid_resource_type'; end if;
  if exists(select 1 from jsonb_object_keys(p_changes) k where not k=any(v_allowed)) then
    raise exception using errcode='22023',message='immutable_or_unknown_field'; end if;
  select string_agg(format('%I=r.%I',k,k),',' order by k) into v_assign from jsonb_object_keys(v_patch) k;
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2',v_table,v_assign,v_table)
    using v_patch,p_id;
  return private.mcp_resource_snapshot_v2(p_user,p_kind,p_id);
end;
$$;

create function public.preview_mcp_operation_v2(p_operation_id uuid,p_nonce_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_op public.mcp_v2_operations%rowtype;v_before jsonb;v_actions jsonb;
begin
  if v_user is null or not public.is_account_active() then raise exception using errcode='42501',message='owner_login_required'; end if;
  select * into strict v_op from public.mcp_v2_operations where id=p_operation_id and user_id=v_user for update;
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||v_user,0));
  if p_nonce_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='invalid_nonce'; end if;
  if v_op.resource_type in ('problem','note','word','todo') then
    v_before:=private.mcp_resource_snapshot_v2(v_user,v_op.resource_type,v_op.resource_id);
  end if;
  update public.mcp_v2_operations set approval_nonce_hash=p_nonce_hash,approval_nonce_expires_at=clock_timestamp()+interval '15 minutes',
    preview_hash=encode(extensions.digest(coalesce(v_before,'{}')::text,'sha256'),'hex'),
    preview_revision=(v_before->>'revision')::bigint,preview_idea_revision=(v_before->>'initial_idea_revision')::bigint
    where id=v_op.id returning * into v_op;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'state',a.state,
    'idea',case when a.kind='initial_idea' then v_op.arguments->>'initial_idea_draft' end)),'[]') into v_actions
    from public.mcp_v2_user_actions a where a.operation_id=v_op.id and a.user_id=v_user;
  return jsonb_build_object('operation_id',v_op.id,'tool_name',v_op.tool_name,'state',v_op.state,
    'resource_type',v_op.resource_type,'resource_id',v_op.resource_id,'before',v_before,
    'changes',v_op.prepared->'changes','after',v_before||coalesce(v_op.prepared->'changes','{}'),
    'revision_changed',v_op.expected_revision is not null and v_op.expected_revision is distinct from (v_before->>'revision')::bigint,
    'actions',v_actions,'error',v_op.error);
end;
$$;

create function public.decide_mcp_operation_v2(p_operation_id uuid,p_nonce_hash text,p_decision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_op public.mcp_v2_operations%rowtype;v_before jsonb;v_after jsonb;
begin
  if v_user is null or not public.is_account_active() then raise exception using errcode='42501',message='owner_login_required'; end if;
  select * into strict v_op from public.mcp_v2_operations where id=p_operation_id and user_id=v_user for update;
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||v_user,0));
  if v_op.state in ('committed','rejected') then
    return jsonb_build_object('state',v_op.state,'replayed',true); end if;
  if v_op.state<>'awaiting_approval' or p_decision not in ('approved','rejected') then
    raise exception using errcode='55000',message='operation_not_awaiting_approval'; end if;
  if v_op.approval_nonce_hash is distinct from p_nonce_hash or v_op.approval_nonce_expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='review_expired'; end if;
  v_before:=private.mcp_resource_snapshot_v2(v_user,v_op.resource_type,v_op.resource_id);
  if encode(extensions.digest(v_before::text,'sha256'),'hex')<>v_op.preview_hash then
    raise exception using errcode='40001',message='revision_conflict'; end if;
  if p_decision='approved' then
    v_after:=private.mcp_apply_changes_v2(v_user,v_op.resource_type,v_op.resource_id,v_op.prepared->'changes');
  end if;
  insert into public.mcp_v2_approvals(operation_id,user_id,decision,proposal_hash,reviewed_hash,before_snapshot,after_snapshot,approved_changes)
    values(v_op.id,v_user,p_decision,v_op.fingerprint,v_op.preview_hash,v_before,v_after,v_op.prepared->'changes');
  update public.mcp_v2_operations set state=case when p_decision='approved' then 'committed' else 'rejected' end,
    receipt=jsonb_build_object('kind','approval','decision',p_decision,'resource_id',v_op.resource_id),
    committed_at=case when p_decision='approved' then clock_timestamp() end,approval_nonce_hash=null,
    updated_at=clock_timestamp() where id=v_op.id;
  return jsonb_build_object('state',case when p_decision='approved' then 'committed' else 'rejected' end,'replayed',false);
end;
$$;

create function private.mcp_merge_assets_v2(p_existing jsonb,p_added jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(a order by ordinal),'[]') from (
    select distinct on (a->>'path') a,ordinal from jsonb_array_elements(coalesce(p_existing,'[]')||coalesce(p_added,'[]')) with ordinality x(a,ordinal)
    order by a->>'path',ordinal desc
  ) x;
$$;
revoke all on function private.mcp_merge_assets_v2(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.complete_mcp_user_action_v2(p_operation_id uuid,p_nonce_hash text,p_action text,
  p_assets jsonb default '[]',p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_op public.mcp_v2_operations%rowtype;v_before jsonb;v_action public.mcp_v2_user_actions%rowtype;v_idea uuid;
  v_assets jsonb;v_solutions jsonb;
begin
  if v_user is null or not public.is_account_active() then raise exception using errcode='42501',message='owner_login_required'; end if;
  select * into strict v_op from public.mcp_v2_operations where id=p_operation_id and user_id=v_user for update;
  perform pg_advisory_xact_lock(hashtextextended('mcp-v2-owner:'||v_user,0));
  if v_op.state<>'committed' then raise exception using errcode='55000',message='operation_not_committed'; end if;
  if v_op.approval_nonce_hash is distinct from p_nonce_hash or v_op.approval_nonce_expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='review_expired'; end if;
  if p_action='images' then
    v_before:=private.mcp_resource_snapshot_v2(v_user,'problem',v_op.resource_id);
    if (v_before->>'revision')::bigint is distinct from p_expected_revision then
      raise exception using errcode='40001',message='revision_conflict'; end if;
    perform private.mcp_check_assets_v2(v_user,p_assets);
    if jsonb_array_length(p_assets)=0 then raise exception using errcode='22023',message='images_required'; end if;
    select coalesce(jsonb_agg(a),'[]') into v_assets from jsonb_array_elements(p_assets) a where coalesce(a->>'role','question')<>'solution';
    select coalesce(jsonb_agg(a),'[]') into v_solutions from jsonb_array_elements(p_assets) a where a->>'role'='solution';
    v_assets:=private.mcp_merge_assets_v2(v_before->'assets',v_assets);
    v_solutions:=private.mcp_merge_assets_v2(v_before->'solution_assets',v_solutions);
    if v_assets is distinct from v_before->'assets' or v_solutions is distinct from v_before->'solution_assets' then
      update public.problems set assets=v_assets,solution_assets=v_solutions where id=v_op.resource_id;
    end if;
    return jsonb_build_object('completed',false,'images_attached',true);
  elsif p_action='confirm_images' then
    v_before:=private.mcp_resource_snapshot_v2(v_user,'problem',v_op.resource_id);
    if (v_before->>'revision')::bigint is distinct from p_expected_revision then
      raise exception using errcode='40001',message='revision_conflict'; end if;
    if jsonb_array_length(coalesce(v_before->'assets','[]'))+jsonb_array_length(coalesce(v_before->'solution_assets','[]'))=0 then
      raise exception using errcode='22023',message='images_required'; end if;
    update public.mcp_v2_user_actions set state='completed',completed_at=clock_timestamp()
      where operation_id=v_op.id and user_id=v_user and kind='images';
    return jsonb_build_object('completed',true);
  elsif p_action='initial_idea' then
    select * into strict v_action from public.mcp_v2_user_actions where operation_id=v_op.id and user_id=v_user and kind=p_action for update;
    if v_action.state='completed' then return jsonb_build_object('completed',true,'replayed',true); end if;
    if v_action.state='dismissed' then raise exception using errcode='55000',message='user_action_dismissed'; end if;
    v_before:=private.mcp_resource_snapshot_v2(v_user,'problem',v_op.resource_id);
    if encode(extensions.digest(v_before::text,'sha256'),'hex')<>v_op.preview_hash then
      raise exception using errcode='40001',message='revision_conflict'; end if;
    v_idea:=private.mcp_set_initial_idea_v2(v_user,v_op.resource_id,v_op.arguments->>'initial_idea_draft');
    update public.problem_initial_idea_mcp_challenges set consumed_at=clock_timestamp(),consumed_revision_id=v_idea where id=v_action.challenge_id;
  elsif p_action='word_deck_access' then
    if not exists(select 1 from public.word_deck_ai_access where deck_id=v_op.resource_id and user_id=v_user) then
      raise exception using errcode='42501',message='manual_permission_required'; end if;
  elsif p_action='dismiss_initial_idea' then
    update public.mcp_v2_user_actions set state='dismissed',completed_at=clock_timestamp()
      where operation_id=v_op.id and user_id=v_user and kind='initial_idea';
    return jsonb_build_object('completed',true,'dismissed',true);
  else raise exception using errcode='22023',message='invalid_user_action'; end if;
  update public.mcp_v2_user_actions set state='completed',completed_at=clock_timestamp()
    where operation_id=v_op.id and user_id=v_user and kind=p_action;
  return jsonb_build_object('completed',true);
end;
$$;

revoke all on function public.propose_mcp_update_v2(uuid,uuid,uuid,text,uuid,jsonb,bigint,bigint) from public,anon,authenticated;
grant execute on function public.propose_mcp_update_v2(uuid,uuid,uuid,text,uuid,jsonb,bigint,bigint) to service_role;
revoke all on function public.preview_mcp_operation_v2(uuid,text),public.decide_mcp_operation_v2(uuid,text,text),
  public.complete_mcp_user_action_v2(uuid,text,text,jsonb,bigint) from public,anon,service_role;
grant execute on function public.preview_mcp_operation_v2(uuid,text),public.decide_mcp_operation_v2(uuid,text,text),
  public.complete_mcp_user_action_v2(uuid,text,text,jsonb,bigint) to authenticated;
revoke all on function private.mcp_resource_snapshot_v2(uuid,text,uuid),private.mcp_check_links_v2(uuid,jsonb),
  private.mcp_check_content_limit_v2(uuid,text,uuid),
  private.mcp_check_assets_v2(uuid,jsonb),private.mcp_set_initial_idea_v2(uuid,uuid,text),
  private.mcp_apply_changes_v2(uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.set_word_deck_ai_access_v2(p_deck_id uuid,p_can_read boolean,p_can_create boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not public.is_account_active() or not exists(select 1 from public.word_decks where id=p_deck_id and (user_id=v_user or is_system) and is_active and archived_at is null) then
    raise exception using errcode='42501',message='word_deck_not_owned'; end if;
  if p_can_create and exists(select 1 from public.word_decks where id=p_deck_id and is_system) then
    raise exception using errcode='42501',message='system_deck_is_read_only'; end if;
  insert into public.word_deck_ai_access(user_id,deck_id,can_read,can_create,can_update)
    values(v_user,p_deck_id,p_can_read,p_can_create,false)
    on conflict(user_id,deck_id) do update set can_read=excluded.can_read,can_create=excluded.can_create,can_update=false;
  return jsonb_build_object('can_read',p_can_read,'can_create',p_can_create,'can_update',false);
end;
$$;
revoke all on function public.set_word_deck_ai_access_v2(uuid,boolean,boolean) from public,anon,service_role;
grant execute on function public.set_word_deck_ai_access_v2(uuid,boolean,boolean) to authenticated;
