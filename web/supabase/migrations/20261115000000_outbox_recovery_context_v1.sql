-- Maintenance evidence only. One SELECT reads actor/MAC, full original session
-- claims and registry observations in one snapshot. No lifecycle refresh,
-- registration, observation, projection, ACK, artifact or device metadata writes.
create function public.read_device_outbox_recovery_context_v1(
  p_user_id uuid, p_device_id uuid, p_domain text, p_session_id uuid,
  p_source_mac text, p_nonce text, p_manifest_sha256 text, p_elf_sha256 text,
  p_part text, p_offset integer, p_expected_context_sha256 text,
  p_token_sha256 text, p_request_ids text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_full jsonb;
  v_sha text;
  v_array jsonb;
  v_rows jsonb;
  v_total integer;
  v_end integer;
  v_limit integer;
  v_receipts jsonb;
begin
  if p_user_id is null or p_device_id is null or p_session_id is null
     or p_domain is null or p_domain not in ('word','note')
     or p_source_mac is null or p_source_mac !~ '^[0-9a-f]{12}$'
     or p_nonce is null or p_nonce !~ '^[0-9a-f]{32}$'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_elf_sha256 is null or p_elf_sha256 !~ '^[0-9a-f]{64}$'
     or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_part is null or p_part not in ('session','pins','candidates','receipts')
     or p_request_ids is null
     or (p_part <> 'receipts' and cardinality(p_request_ids)<>0)
     or (p_part = 'receipts' and (cardinality(p_request_ids) not between 1 and 16
       or array_ndims(p_request_ids)<>1
       or exists(select 1 from unnest(p_request_ids) r(id) where id is null or id !~ '^[A-Za-z0-9_-]{16,64}$')
       or (select count(distinct id) from unnest(p_request_ids) r(id))<>cardinality(p_request_ids)))
     or p_offset is null or p_offset < 0 or p_offset > 500
     or (p_part in ('session','receipts') and p_offset <> 0)
     or (p_part <> 'session' and p_expected_context_sha256 is null)
     or (p_expected_context_sha256 is not null and p_expected_context_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_RECOVERY_CONTEXT_QUERY';
  end if;

  with owned as materialized (
    select s.* from public.study_sessions s
    join public.esp32_devices d on d.id=p_device_id and d.user_id=p_user_id
    join public.user_profiles u on u.id=p_user_id and u.is_active=true
    where s.id=p_session_id and s.user_id=p_user_id and s.device_id=p_device_id
      and s.domain=p_domain and d.access_token_hash=p_token_sha256
      and d.mac_address ~* '^([0-9a-f]{12}|([0-9a-f]{2}:){5}[0-9a-f]{2})$'
      and pg_catalog.replace(pg_catalog.lower(d.mac_address),':','')=p_source_mac
  ), pins as (
    select j.ordinal-1 as index, j.value as pin,
      case when s.domain='word' then jsonb_build_object(
        'kind','word_ready_registry',
        'state',coalesce(w.status,'missing'),
        'record',case when w.id is null then 'null'::jsonb else jsonb_build_object(
          'pack_id',w.id,'pack_revision',w.revision,'sha256',w.sha256,
          'schema_version',w.schema_version,'format',w.format,'compression',w.compression,
          'entry_count',w.entry_count,'byte_size',w.byte_size,'created_at',w.created_at
        ) end
      ) else jsonb_build_object(
        'kind','note_artifact_registry',
        'state',case when a.sha256 is null then 'missing' else 'found' end,
        'record',case when a.sha256 is null then 'null'::jsonb else jsonb_build_object(
          'logical_id',a.logical_id,'revision',a.revision,'sha256',a.sha256,
          'byte_size',a.byte_size,'created_at',a.created_at
        ) end
      ) end as registry
    from owned s
    cross join lateral jsonb_array_elements(s.snapshot) with ordinality j(value,ordinal)
    left join public.word_packs w on s.domain='word'
      and w.deck_id=(j.value->>'deck_id')::uuid
      and w.revision=(j.value->>'pack_revision')::bigint
      and w.sha256=j.value->>'sha256'
      and w.schema_version=2 and w.format='jsonl' and w.compression='none'
    left join public.device_pack_artifacts a on s.domain='note'
      and a.user_id=p_user_id and a.domain='note_packs'
      and a.logical_id=(j.value->>'notebook_id')::uuid and a.sha256=j.value->>'sha256'
  )
  select jsonb_build_object(
    'actor',jsonb_build_object('user_id',p_user_id,'device_id',p_device_id),
    'binding',jsonb_build_object('source_mac',p_source_mac,'nonce',p_nonce,
      'manifest_sha256',p_manifest_sha256,'elf_sha256',p_elf_sha256),
    'session',jsonb_build_object(
      'session_id',s.id,'domain',s.domain,'mode',s.mode,'purpose',s.purpose,
      'ordering',s.ordering,'scope',s.scope,'optional_count',s.optional_count,
      'seed',s.seed,'progress_revision',s.progress_revision,'next_sequence',s.next_sequence,
      'candidate_count',s.candidate_count,'snapshot_count',jsonb_array_length(s.snapshot),
      'cursor',s.cursor,'has_more',s.has_more,'status',s.status,
      'started_at',s.started_at,'ended_at',s.ended_at,'expires_at',s.expires_at,
      'create_request_id',s.create_request_id,'create_fingerprint',s.create_fingerprint,
      'local_session',s.local_session,'local_start_index',s.local_start_index,
      'local_fingerprint',s.local_fingerprint
    ),
    'pins',coalesce((select jsonb_agg(jsonb_build_object('index',p.index,'pin',p.pin,
      'registry',p.registry) order by p.index) from pins p),'[]'::jsonb),
    'candidates',s.candidate_items
  ) into v_full from owned s;
  if v_full is null then return null; end if;
  if jsonb_array_length(v_full->'candidates')<>(v_full#>>'{session,candidate_count}')::integer
     or jsonb_array_length(v_full->'candidates')>500
     or jsonb_array_length(v_full->'pins')>32 then
    raise exception using errcode='22023', message='INVALID_OUTBOX_RECOVERY_CONTEXT_MATERIAL';
  end if;

  -- Opaque server context identity, not a device MAC or an attestation. Every
  -- page recomputes ALL claims/registry observations; read_at/part/offset are
  -- excluded. A caller must use the same source binding and expected identity.
  v_sha:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    'outbox-recovery-context-v1' || chr(10) || v_full::text,'UTF8'),'sha256'),'hex');
  if p_expected_context_sha256 is not null and p_expected_context_sha256<>v_sha then
    raise exception using errcode='40001', message='OUTBOX_RECOVERY_CONTEXT_CHANGED';
  end if;
  if p_part='session' then
    return jsonb_build_object('contract','outbox-recovery-context-v1','read_at',statement_timestamp(),
      'context_sha256',v_sha,'actor',v_full->'actor','binding',v_full->'binding',
      'session_id',p_session_id,'domain',p_domain,'part','session',
      'offset',0,'total_count',1,'next_offset',1,'has_more',false,
      'session',v_full->'session','repair_authorized',false);
  end if;
  if p_part='receipts' then
    -- STABLE nested read uses this statement's snapshot. It cannot perform an
    -- observation write or consult the active-session paging policy.
    v_receipts:=public.lookup_device_outbox_receipts_v1(
      p_user_id,p_device_id,p_domain,p_session_id,p_request_ids
    );
    if v_receipts is null then return null; end if;
    v_total:=cardinality(p_request_ids);
    return jsonb_build_object('contract','outbox-recovery-context-v1','read_at',statement_timestamp(),
      'context_sha256',v_sha,'actor',v_full->'actor','binding',v_full->'binding',
      'session_id',p_session_id,'domain',p_domain,'part','receipts','mode',v_full#>>'{session,mode}',
      'offset',0,'total_count',v_total,'next_offset',v_total,'has_more',false,
      'receipts',v_receipts->'receipts','repair_authorized',false);
  end if;
  v_array:=v_full->p_part; v_total:=jsonb_array_length(v_array);
  if p_offset>v_total then
    raise exception using errcode='22023', message='INVALID_OUTBOX_RECOVERY_CONTEXT_OFFSET';
  end if;
  v_limit:=case when p_part='pins' then 8 else 32 end;
  v_end:=least(v_total,p_offset+v_limit);
  select coalesce(jsonb_agg(case when p_part='pins' then j.value else
      jsonb_build_object('index',j.ordinal-1,'item',j.value) end order by j.ordinal),'[]'::jsonb)
    into v_rows from jsonb_array_elements(v_array) with ordinality j(value,ordinal)
    where j.ordinal>p_offset and j.ordinal<=v_end;
  return jsonb_build_object('contract','outbox-recovery-context-v1','read_at',statement_timestamp(),
    'context_sha256',v_sha,'actor',v_full->'actor','binding',v_full->'binding',
    'session_id',p_session_id,'domain',p_domain,'part',p_part,'offset',p_offset,
    'total_count',v_total,'next_offset',v_end,'has_more',v_end<v_total,
    p_part,v_rows,'repair_authorized',false);
end;
$$;

revoke all on function public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])
  from public,anon,authenticated;
grant execute on function public.read_device_outbox_recovery_context_v1(uuid,uuid,text,uuid,text,text,text,text,text,integer,text,text,text[])
  to service_role;
