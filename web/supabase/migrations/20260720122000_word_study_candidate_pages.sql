-- Word Study v1 candidate paging closure.
--
-- Candidate ordering is materialized once per session so later progress
-- updates cannot reorder, skip, or repeat unseen words.  The session row keeps
-- only the first transport page for compatibility; the normalized table is
-- the authoritative membership and continuation source.

alter table public.study_sessions
  add column if not exists progress_revision bigint not null default 0,
  add column if not exists candidate_count integer not null default 0,
  add column if not exists candidates_ready boolean not null default false;

alter table public.study_sessions
  drop constraint if exists study_sessions_progress_revision_v1_check,
  add constraint study_sessions_progress_revision_v1_check
    check (progress_revision between 0 and 9007199254740991),
  drop constraint if exists study_sessions_candidate_count_v1_check,
  add constraint study_sessions_candidate_count_v1_check
    check (candidate_count between 0 and 320000);

create table if not exists public.study_session_candidates (
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  ordinal integer not null,
  item_id uuid not null references public.word_entries(id) on delete restrict,
  deck_id uuid not null references public.word_decks(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (session_id, ordinal),
  unique (session_id, item_id),
  constraint study_session_candidates_ordinal_v1_check
    check (ordinal between 0 and 319999)
);

create index if not exists study_session_candidates_item_v1_idx
  on public.study_session_candidates (session_id, item_id);

alter table public.study_session_candidates enable row level security;
revoke all on table public.study_session_candidates from anon, authenticated;
grant select on table public.study_session_candidates to authenticated;
grant all on table public.study_session_candidates to service_role;

drop policy if exists study_session_candidates_owner_select_v1
  on public.study_session_candidates;
create policy study_session_candidates_owner_select_v1
on public.study_session_candidates
for select to authenticated
using (
  exists (
    select 1
    from public.study_sessions s
    where s.id = study_session_candidates.session_id
      and s.user_id = (select auth.uid())
  )
);

-- Preserve sessions created before this migration.  Their complete candidate
-- set was held in candidate_items/candidate_ids (at most 500 entries).
insert into public.study_session_candidates (session_id, ordinal, item_id, deck_id)
select
  s.id,
  coalesce((item.value ->> 'ordinal')::integer, item.ordinality::integer - 1),
  (item.value ->> 'item_id')::uuid,
  (item.value ->> 'deck_id')::uuid
from public.study_sessions s
cross join lateral jsonb_array_elements(s.candidate_items)
  with ordinality as item(value, ordinality)
on conflict do nothing;

update public.study_sessions s
set candidate_count = counts.value,
    candidates_ready = true
from (
  select c.session_id, count(*)::integer as value
  from public.study_session_candidates c
  group by c.session_id
) counts
where s.id = counts.session_id;

update public.study_sessions s
set progress_revision = coalesce((
  select max(l.sequence)::bigint
  from public.word_change_log l
  where l.user_id = s.user_id and l.entity_kind = 'progress'
), 0);

update public.study_sessions
set candidates_ready = true
where candidate_count = 0 and jsonb_array_length(candidate_items) = 0;

-- record_study_observation_v1 is intentionally retained as the single atomic
-- projection boundary.  Patch only its membership predicate so historical
-- sessions continue to use candidate_ids while paged sessions use the
-- normalized candidate snapshot.  Abort the migration if the known previous
-- definition is not present; silently weakening this check is not acceptable.
do $migration$
declare
  function_definition text;
  old_predicate constant text :=
    'if not (p_item_id = any(v_session.candidate_ids)) then';
  new_predicate constant text :=
    'if not exists (' || chr(10) ||
    '    select 1 from public.study_session_candidates c' || chr(10) ||
    '    where c.session_id = p_session_id and c.item_id = p_item_id' || chr(10) ||
    '  ) and not (p_item_id = any(v_session.candidate_ids)) then';
begin
  select pg_catalog.pg_get_functiondef(
    'public.record_study_observation_v1(uuid,uuid,text,uuid,bigint,uuid,text,text,timestamp with time zone)'::regprocedure
  ) into function_definition;

  if function_definition is null or pg_catalog.strpos(function_definition, old_predicate) = 0 then
    raise exception 'record_study_observation_v1 membership predicate not found';
  end if;

  execute pg_catalog.replace(function_definition, old_predicate, new_predicate);
end;
$migration$;
