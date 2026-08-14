-- Personal initial ideas are private user evidence. They are deliberately
-- separate from objective Problem semantics and Problem Mark annotation state.

create unique index if not exists problems_id_user_id_uidx
  on public.problems (id, user_id);

create table public.problem_initial_idea_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  problem_id uuid not null,
  revision bigint not null,
  revision_kind text not null,
  idea text,
  channel_source text not null,
  idea_origin text not null,
  created_at timestamptz not null default now(),
  constraint problem_initial_idea_revisions_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_initial_idea_revisions_revision_check
    check (revision between 1 and 9007199254740991),
  constraint problem_initial_idea_revisions_kind_check
    check (revision_kind in ('set', 'clear')),
  constraint problem_initial_idea_revisions_idea_check
    check (
      (
        revision_kind = 'set'
        and idea is not null
        and btrim(idea) <> ''
        and char_length(idea) <= 4000
        and octet_length(idea) <= 16000
      )
      or (revision_kind = 'clear' and idea is null)
    ),
  constraint problem_initial_idea_revisions_channel_check
    check (channel_source in ('web', 'device', 'mcp', 'migration')),
  constraint problem_initial_idea_revisions_origin_check
    check (
      idea_origin in (
        'user_typed',
        'user_confirmed_asr',
        'user_confirmed_external'
      )
    ),
  constraint problem_initial_idea_revisions_sequence_key
    unique (user_id, problem_id, revision),
  constraint problem_initial_idea_revisions_head_key
    unique (id, user_id, problem_id)
);

create table public.problem_user_contexts (
  user_id uuid not null,
  problem_id uuid not null,
  current_initial_idea_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, problem_id),
  constraint problem_user_contexts_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_user_contexts_current_revision_fkey
    foreign key (current_initial_idea_revision_id, user_id, problem_id)
    references public.problem_initial_idea_revisions (id, user_id, problem_id)
    on delete set null (current_initial_idea_revision_id)
);

create index problem_initial_idea_revisions_user_created_idx
  on public.problem_initial_idea_revisions (user_id, created_at desc);
create index problem_initial_idea_revisions_problem_created_idx
  on public.problem_initial_idea_revisions (problem_id, created_at desc);

alter table public.problem_user_contexts enable row level security;
alter table public.problem_initial_idea_revisions enable row level security;

revoke all on table public.problem_user_contexts
  from public, anon, authenticated;
revoke all on table public.problem_initial_idea_revisions
  from public, anon, authenticated;
grant select on table public.problem_user_contexts to authenticated;
grant select on table public.problem_initial_idea_revisions to authenticated;
grant all on table public.problem_user_contexts to service_role;
grant all on table public.problem_initial_idea_revisions to service_role;

create policy problem_user_contexts_owner_select
  on public.problem_user_contexts
for select to authenticated
using ((select auth.uid()) = user_id);

create policy problem_initial_idea_revisions_owner_select
  on public.problem_initial_idea_revisions
for select to authenticated
using ((select auth.uid()) = user_id);

-- Revisions cannot be rewritten, including by privileged application code.
-- DELETE remains available to service_role/postgres for privacy erasure and
-- auth.users/Problem cascades.
create or replace function public.prevent_problem_initial_idea_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'INITIAL_IDEA_REVISIONS_APPEND_ONLY';
end;
$$;

create trigger prevent_problem_initial_idea_revision_update
before update on public.problem_initial_idea_revisions
for each row execute function public.prevent_problem_initial_idea_revision_update();

revoke all on function public.prevent_problem_initial_idea_revision_update()
  from public, anon, authenticated;
grant execute on function public.prevent_problem_initial_idea_revision_update()
  to service_role;

-- Keep privileged writes outside the Data API's exposed schemas. The public
-- wrapper below is SECURITY INVOKER; this private helper derives the owner from
-- auth.uid() and never accepts provenance fields from the caller.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create or replace function private.append_web_problem_initial_idea_revision(
  p_problem_id uuid,
  p_revision_kind text,
  p_idea text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_context public.problem_user_contexts%rowtype;
  v_current public.problem_initial_idea_revisions%rowtype;
  v_inserted public.problem_initial_idea_revisions%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_revision_kind not in ('set', 'clear')
     or (p_revision_kind = 'set' and (
       p_idea is null
       or btrim(p_idea) = ''
       or char_length(p_idea) > 4000
       or octet_length(p_idea) > 16000
     ))
     or (p_revision_kind = 'clear' and p_idea is not null) then
    raise exception using errcode = '22023', message = 'INVALID_INITIAL_IDEA_REVISION';
  end if;

  if not exists (
    select 1
    from public.problems problem
    where problem.id = p_problem_id
      and problem.user_id = v_user_id
  ) then
    raise exception using errcode = '42501', message = 'PROBLEM_NOT_OWNED';
  end if;

  insert into public.problem_user_contexts (user_id, problem_id)
  values (v_user_id, p_problem_id)
  on conflict (user_id, problem_id) do nothing;

  select * into strict v_context
  from public.problem_user_contexts context
  where context.user_id = v_user_id
    and context.problem_id = p_problem_id
  for update;

  if v_context.current_initial_idea_revision_id is not null then
    select * into strict v_current
    from public.problem_initial_idea_revisions revision
    where revision.id = v_context.current_initial_idea_revision_id;

    if v_current.revision_kind = p_revision_kind
       and v_current.idea is not distinct from p_idea then
      return jsonb_build_object(
        'problem_id', v_current.problem_id,
        'revision_id', v_current.id,
        'revision', v_current.revision,
        'revision_kind', v_current.revision_kind,
        'idea', v_current.idea,
        'replayed', true
      );
    end if;
  end if;

  insert into public.problem_initial_idea_revisions (
    user_id,
    problem_id,
    revision,
    revision_kind,
    idea,
    channel_source,
    idea_origin
  ) values (
    v_user_id,
    p_problem_id,
    coalesce(v_current.revision, 0) + 1,
    p_revision_kind,
    p_idea,
    'web',
    'user_typed'
  )
  returning * into v_inserted;

  update public.problem_user_contexts
  set current_initial_idea_revision_id = v_inserted.id,
      updated_at = now()
  where user_id = v_user_id
    and problem_id = p_problem_id;

  return jsonb_build_object(
    'problem_id', v_inserted.problem_id,
    'revision_id', v_inserted.id,
    'revision', v_inserted.revision,
    'revision_kind', v_inserted.revision_kind,
    'idea', v_inserted.idea,
    'replayed', false
  );
end;
$$;

revoke all on function private.append_web_problem_initial_idea_revision(
  uuid, text, text
) from public, anon;
grant execute on function private.append_web_problem_initial_idea_revision(
  uuid, text, text
) to authenticated, service_role;

create or replace function public.set_problem_initial_idea(
  p_problem_id uuid,
  p_revision_kind text,
  p_idea text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.append_web_problem_initial_idea_revision($1, $2, $3);
$$;

revoke all on function public.set_problem_initial_idea(uuid, text, text)
  from public, anon;
grant execute on function public.set_problem_initial_idea(uuid, text, text)
  to authenticated;
