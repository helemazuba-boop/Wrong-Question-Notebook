-- Notebook HTML and the reading-overview endpoint call this RPC with a user
-- client. Permit that path while pinning the explicit user ID to the verified
-- JWT; service-role callers retain their existing backend projection access.

create or replace function public.get_recent_note_reads_v2(
  p_user_id uuid,
  p_notebook_id uuid default null,
  p_limit integer default 12
)
returns table (
  note_id uuid,
  notebook_id uuid,
  notebook_title text,
  note_title text,
  state text,
  last_opened_at timestamptz,
  last_completed_at timestamptz,
  completed_count bigint,
  actor text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    note.id as note_id,
    note.notebook_id,
    coalesce(notebook.title, '笔记本') as notebook_title,
    note.title as note_title,
    case
      when read_state.last_completed_at is not null then 'completed'
      when read_state.last_opened_at is not null then 'reading'
      else 'unread'
    end as state,
    read_state.last_opened_at,
    read_state.last_completed_at,
    read_state.completed_count,
    case
      when latest_observation.item_id is null then 'unknown'
      when latest_observation.device_id is null then 'web'
      else 'note4'
    end as actor
  from public.note_read_state read_state
  join public.notebook_notes note
    on note.id = read_state.note_id
   and note.user_id = p_user_id
   and note.archived_at is null
  left join public.notebooks notebook
    on notebook.id = note.notebook_id
  left join lateral (
    select observation.item_id, observation.device_id
    from public.study_observations observation
    where observation.user_id = p_user_id
      and observation.item_id = note.id
      and observation.action in ('opened', 'read_completed')
    order by observation.occurred_at desc
    limit 1
  ) latest_observation on true
  where read_state.user_id = p_user_id
    and ((select auth.role()) = 'service_role' or p_user_id = (select auth.uid()))
    and read_state.last_opened_at is not null
    and (p_notebook_id is null or note.notebook_id = p_notebook_id)
  order by read_state.last_opened_at desc
  limit least(greatest(coalesce(p_limit, 12), 1), 40);
$$;

revoke all on function public.get_recent_note_reads_v2(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_recent_note_reads_v2(uuid, uuid, integer)
  to authenticated, service_role;
