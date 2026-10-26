-- Derived pointers to immutable packs. Apply before deploying the manifest
-- readers; reverting the readers leaves this additive schema harmless.
create table public.device_pack_summaries (
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null check (domain in ('note_packs', 'problem_packs')),
  logical_id uuid not null,
  source_key text not null check (source_key ~ '^[0-9a-f]{64}$'),
  sha256 text not null,
  pack_revision bigint not null check (pack_revision >= 0),
  entry_count integer not null check (entry_count >= 0),
  byte_size bigint not null check (byte_size >= 0),
  primary key (user_id, domain, logical_id),
  foreign key (user_id, domain, logical_id, sha256)
    references public.device_pack_artifacts(user_id, domain, logical_id, sha256)
    on delete cascade
);
alter table public.device_pack_summaries enable row level security;
revoke all on public.device_pack_summaries from public, anon, authenticated;
grant all on public.device_pack_summaries to service_role;

-- One lightweight, ordered row per owned active notebook. The note identity
-- fingerprint covers moves out of a notebook as well as revision/sort changes;
-- note_change_log alone records only the destination of a move.
create function public.device_note_pack_sources_v1(p_user_id uuid)
returns table(id uuid, title text, content_revision bigint, source_key text)
language sql stable security definer set search_path = ''
as $$
  select n.id, n.title, coalesce(h.change_seq, 0),
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(coalesce(h.change_seq, 0), members.identities,
        coalesce((select r.revision from public.device_content_revisions r
          where r.scope_key=p_user_id::text || ':device_images'
            and r.domain='note_packs'), 0))::text,
      'UTF8')), 'hex')
  from public.notebooks n
  left join lateral (
    select l.change_seq from public.note_change_log l
    where l.user_id = p_user_id and l.notebook_id = n.id
    order by l.change_seq desc limit 1
  ) h on true
  left join lateral (
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(nn.id, nn.revision, nn.sort_index)
      order by nn.id), '[]'::jsonb) as identities
    from public.notebook_notes nn
    where nn.user_id = p_user_id and nn.notebook_id = n.id
      and nn.archived_at is null
  ) members on true
  where n.user_id = p_user_id and n.archived_at is null
  order by n.id;
$$;
revoke all on function public.device_note_pack_sources_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.device_note_pack_sources_v1(uuid) to service_role;

-- Ownership transfers invalidate both users. Existing triggers on notes,
-- notebooks, sets, members and problems use this shared function.
create or replace function public.bump_device_content_from_user_row()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
  v_user uuid;
begin
  if tg_op <> 'INSERT' then v_old := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new := new.user_id; end if;
  for v_user in select distinct x from unnest(array[v_old, v_new]) x
    where x is not null order by x
  loop
    perform public.bump_device_content_revision(v_user::text, tg_argv[0]);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.bump_device_content_from_user_row()
  from public, anon, authenticated;

-- Smart-set membership depends on tag links even when the problem is unchanged.
create trigger device_content_problem_tag
after insert or update or delete on public.problem_tag
for each row execute function public.bump_device_content_from_user_row('problem_packs');
create trigger device_content_note_history
after update or delete on public.note_change_log
for each row execute function public.bump_device_content_from_user_row('note_packs');

-- Keep only currently listed containers in the small pointer table. Issued
-- artifacts remain immutable and are not removed by this metadata cleanup.
create function public.prune_device_pack_summary_v1()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.device_pack_summaries
      where user_id=old.user_id and domain=tg_argv[0] and logical_id=old.id;
    return old;
  end if;
  if old.user_id is distinct from new.user_id or old.id is distinct from new.id
     or (to_jsonb(new)->>'archived_at') is not null then
    delete from public.device_pack_summaries
      where user_id=old.user_id and domain=tg_argv[0] and logical_id=old.id;
  end if;
  return new;
end;
$$;
revoke all on function public.prune_device_pack_summary_v1()
  from public, anon, authenticated;
create trigger prune_note_pack_summary after update or delete on public.notebooks
for each row execute function public.prune_device_pack_summary_v1('note_packs');
create trigger prune_problem_pack_summary after update or delete on public.problem_sets
for each row execute function public.prune_device_pack_summary_v1('problem_packs');

-- Artifact removal must also invalidate cached pointers and cross-page lists.
create function public.invalidate_device_pack_summary_v1()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform public.bump_device_content_revision(old.user_id::text, old.domain);
  return old;
end;
$$;
revoke all on function public.invalidate_device_pack_summary_v1()
  from public, anon, authenticated;
create trigger invalidate_device_pack_summary
after delete on public.device_pack_artifacts
for each row execute function public.invalidate_device_pack_summary_v1();

create function public.invalidate_device_image_summaries_v1()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  -- Changing source identity also rejects an old builder's late cache write.
  -- Ordinary note edits can still invalidate just the changed notebook.
  perform public.bump_device_content_revision(old.user_id::text || ':device_images', 'note_packs');
  delete from public.device_pack_summaries where user_id = old.user_id;
  perform public.bump_device_content_revision(old.user_id::text, 'note_packs');
  perform public.bump_device_content_revision(old.user_id::text, 'problem_packs');
  return old;
end;
$$;
revoke all on function public.invalidate_device_image_summaries_v1()
  from public, anon, authenticated;
create trigger invalidate_device_image_summaries
after delete on public.device_image_artifacts
for each row execute function public.invalidate_device_image_summaries_v1();

-- last_seen_at currently has no pruning consumer. Any future artifact GC must
-- retain referenced summaries and issued immutable snapshots, including their
-- images; last_seen_at alone is not a retention contract.
