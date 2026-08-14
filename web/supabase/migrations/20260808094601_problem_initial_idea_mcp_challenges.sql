-- MCP callers cannot attest that their own text came from the user. Store the
-- proposed text as a short-lived machine draft and require a separate,
-- cookie-authenticated Web confirmation before it becomes human evidence.

create unique index if not exists user_api_tokens_id_user_id_uidx
  on public.user_api_tokens (id, user_id);

create table public.problem_initial_idea_mcp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  problem_id uuid not null,
  source_api_token_id uuid not null,
  source_request_id text not null,
  proposed_idea text not null,
  exact_text_hash text not null,
  challenge_token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_revision_id uuid,
  created_at timestamptz not null default now(),
  constraint problem_initial_idea_mcp_challenges_problem_owner_fkey
    foreign key (problem_id, user_id)
    references public.problems (id, user_id)
    on delete cascade,
  constraint problem_initial_idea_mcp_challenges_source_token_fkey
    foreign key (source_api_token_id, user_id)
    references public.user_api_tokens (id, user_id)
    on delete cascade,
  constraint problem_initial_idea_mcp_challenges_consumed_revision_fkey
    foreign key (consumed_revision_id, user_id, problem_id)
    references public.problem_initial_idea_revisions (id, user_id, problem_id)
    on delete set null (consumed_revision_id),
  constraint problem_initial_idea_mcp_challenges_request_id_check
    check (
      char_length(source_request_id) between 16 and 64
      and source_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
  constraint problem_initial_idea_mcp_challenges_idea_check
    check (
      btrim(proposed_idea) <> ''
      and char_length(proposed_idea) <= 4000
      and octet_length(proposed_idea) <= 16000
    ),
  constraint problem_initial_idea_mcp_challenges_text_hash_check
    check (exact_text_hash ~ '^[0-9a-f]{64}$'),
  constraint problem_initial_idea_mcp_challenges_token_hash_check
    check (challenge_token_hash ~ '^[0-9a-f]{64}$'),
  constraint problem_initial_idea_mcp_challenges_expiry_check
    check (expires_at > created_at),
  constraint problem_initial_idea_mcp_challenges_consumed_check
    check (consumed_revision_id is null or consumed_at is not null),
  constraint problem_initial_idea_mcp_challenges_request_key
    unique (user_id, source_request_id)
);

create index problem_initial_idea_mcp_challenges_owner_created_idx
  on public.problem_initial_idea_mcp_challenges (user_id, created_at desc);
create index problem_initial_idea_mcp_challenges_expiry_idx
  on public.problem_initial_idea_mcp_challenges (expires_at)
  where consumed_at is null;

alter table public.problem_initial_idea_mcp_challenges enable row level security;

-- The draft and token digest are server-internal. The owner sees the exact
-- draft only through the authenticated preview endpoint after presenting the
-- one-time plaintext token. No Data API role receives direct table access.
revoke all on table public.problem_initial_idea_mcp_challenges
  from public, anon, authenticated;
grant all on table public.problem_initial_idea_mcp_challenges to service_role;

create or replace function private.confirm_mcp_problem_initial_idea(
  p_challenge_id uuid,
  p_challenge_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_challenge public.problem_initial_idea_mcp_challenges%rowtype;
  v_context public.problem_user_contexts%rowtype;
  v_current public.problem_initial_idea_revisions%rowtype;
  v_revision public.problem_initial_idea_revisions%rowtype;
  v_token_hash text;
  v_replayed boolean := false;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_challenge_token is null
     or p_challenge_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'INVALID_MCP_IDEA_CHALLENGE_TOKEN';
  end if;

  select * into v_challenge
  from public.problem_initial_idea_mcp_challenges challenge
  where challenge.id = p_challenge_id
    and challenge.user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'MCP_IDEA_CHALLENGE_NOT_FOUND';
  end if;

  if v_challenge.consumed_at is not null then
    raise exception using errcode = '55000', message = 'MCP_IDEA_CHALLENGE_ALREADY_CONSUMED';
  end if;

  if v_challenge.expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'MCP_IDEA_CHALLENGE_EXPIRED';
  end if;

  v_token_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_challenge_token, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if v_token_hash <> v_challenge.challenge_token_hash then
    raise exception using errcode = '42501', message = 'MCP_IDEA_CHALLENGE_TOKEN_MISMATCH';
  end if;

  if pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_challenge.proposed_idea, 'UTF8'),
         'sha256'
       ),
       'hex'
     ) <> v_challenge.exact_text_hash then
    raise exception using errcode = '55000', message = 'MCP_IDEA_CHALLENGE_TEXT_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.problems problem
    where problem.id = v_challenge.problem_id
      and problem.user_id = v_user_id
  ) then
    raise exception using errcode = '42501', message = 'PROBLEM_NOT_OWNED';
  end if;

  insert into public.problem_user_contexts (user_id, problem_id)
  values (v_user_id, v_challenge.problem_id)
  on conflict (user_id, problem_id) do nothing;

  select * into strict v_context
  from public.problem_user_contexts context
  where context.user_id = v_user_id
    and context.problem_id = v_challenge.problem_id
  for update;

  if v_context.current_initial_idea_revision_id is not null then
    select * into strict v_current
    from public.problem_initial_idea_revisions revision
    where revision.id = v_context.current_initial_idea_revision_id;
  end if;

  if v_current.id is not null
     and v_current.revision_kind = 'set'
     and v_current.idea = v_challenge.proposed_idea
     and v_current.channel_source = 'mcp'
     and v_current.idea_origin = 'user_confirmed_external' then
    v_revision := v_current;
    v_replayed := true;
  else
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
      v_challenge.problem_id,
      coalesce(v_current.revision, 0) + 1,
      'set',
      v_challenge.proposed_idea,
      'mcp',
      'user_confirmed_external'
    )
    returning * into v_revision;

    update public.problem_user_contexts
    set current_initial_idea_revision_id = v_revision.id,
        updated_at = now()
    where user_id = v_user_id
      and problem_id = v_challenge.problem_id;
  end if;

  update public.problem_initial_idea_mcp_challenges
  set consumed_at = clock_timestamp(),
      consumed_revision_id = v_revision.id
  where id = v_challenge.id;

  return jsonb_build_object(
    'challenge_id', v_challenge.id,
    'problem_id', v_challenge.problem_id,
    'revision_id', v_revision.id,
    'revision', v_revision.revision,
    'revision_kind', v_revision.revision_kind,
    'idea', v_revision.idea,
    'channel_source', v_revision.channel_source,
    'idea_origin', v_revision.idea_origin,
    'replayed', v_replayed
  );
end;
$$;

revoke all on function private.confirm_mcp_problem_initial_idea(uuid, text)
  from public, anon;
grant execute on function private.confirm_mcp_problem_initial_idea(uuid, text)
  to authenticated, service_role;

create or replace function public.confirm_mcp_problem_initial_idea(
  p_challenge_id uuid,
  p_challenge_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.confirm_mcp_problem_initial_idea($1, $2);
$$;

revoke all on function public.confirm_mcp_problem_initial_idea(uuid, text)
  from public, anon;
grant execute on function public.confirm_mcp_problem_initial_idea(uuid, text)
  to authenticated;
