begin;

select plan(31);

select has_table(
  'public',
  'problem_initial_idea_mcp_challenges',
  'MCP initial idea machine drafts have a challenge table'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_mcp_challenges',
    'SELECT'
  ),
  false,
  'authenticated users cannot query challenge drafts directly'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_mcp_challenges',
    'INSERT'
  ),
  false,
  'authenticated users cannot mint challenges directly'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.confirm_mcp_problem_initial_idea(uuid,text)',
    'EXECUTE'
  ),
  true,
  'authenticated users may invoke the constrained confirmation RPC'
);
select is(
  has_function_privilege(
    'anon',
    'public.confirm_mcp_problem_initial_idea(uuid,text)',
    'EXECUTE'
  ),
  false,
  'anonymous users cannot invoke the confirmation RPC'
);
select is(
  (
    select p.prosecdef
    from pg_proc p
    where p.oid =
      'private.confirm_mcp_problem_initial_idea(uuid,text)'::regprocedure
  ),
  true,
  'the private confirmation writer is SECURITY DEFINER'
);
select is(
  (
    select exists (
      select 1
      from unnest(coalesce(p.proconfig, array[]::text[])) setting
      where setting = 'search_path=' or setting = 'search_path=""'
    )
    from pg_proc p
    where p.oid =
      'private.confirm_mcp_problem_initial_idea(uuid,text)'::regprocedure
  ),
  true,
  'the private confirmation writer has an empty search path'
);
select is(
  (
    select count(*)::integer
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    where p.oid =
      'private.confirm_mcp_problem_initial_idea(uuid,text)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'the private confirmation writer is not executable by PUBLIC'
);

insert into auth.users (
  id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    'a1000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'mcp-idea-owner@example.invalid', '',
    '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'mcp-idea-other@example.invalid', '',
    '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.subjects (id, user_id, name, color, icon)
values (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'MCP idea challenge', 'amber', 'NotebookPen'
);

insert into public.problems (
  id, user_id, subject_id, title, content, assets, solution_assets,
  status, parts, source, is_optional
) values (
  'a3000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'MCP idea fixture', 'Objective content', '[]'::jsonb, '[]'::jsonb,
  'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb,
  '{}'::jsonb, false
);

insert into public.user_api_tokens (
  id, user_id, name, token_hash
) values (
  'a4000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'MCP idea fixture token', repeat('a', 64)
);

insert into public.problem_initial_idea_mcp_challenges (
  id, user_id, problem_id, source_api_token_id, source_request_id,
  proposed_idea, exact_text_hash, challenge_token_hash, expires_at
) values
  (
    'a5000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    'mcp_idea_challenge_valid_0001',
    '我先尝试枚举全部因数。',
    encode(extensions.digest(convert_to('我先尝试枚举全部因数。', 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(repeat('v', 43), 'UTF8'), 'sha256'), 'hex'),
    now() + interval '10 minutes'
  ),
  (
    'a5000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    'mcp_idea_challenge_expired_01',
    '过期机器草稿',
    encode(extensions.digest(convert_to('过期机器草稿', 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(repeat('e', 43), 'UTF8'), 'sha256'), 'hex'),
    now() + interval '1 millisecond'
  );

select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  0,
  'creating machine draft challenges does not write human revisions'
);
select is(
  (
    select count(*)::integer
    from public.problem_user_contexts
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  0,
  'creating machine drafts does not create a human context head'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.confirm_mcp_problem_initial_idea(
      'a5000000-0000-4000-8000-000000000001', repeat('v', 43)
    )$$,
  '42501',
  'MCP_IDEA_CHALLENGE_NOT_FOUND',
  'another user cannot confirm the owner challenge'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  0,
  'wrong-user confirmation does not create human evidence'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.confirm_mcp_problem_initial_idea(
      'a5000000-0000-4000-8000-000000000001', repeat('x', 43)
    )$$,
  '42501',
  'MCP_IDEA_CHALLENGE_TOKEN_MISMATCH',
  'a wrong one-time token cannot confirm the draft'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  0,
  'wrong-token confirmation does not create human evidence'
);
select pg_sleep(0.01);
select throws_ok(
  $$select public.confirm_mcp_problem_initial_idea(
      'a5000000-0000-4000-8000-000000000002', repeat('e', 43)
    )$$,
  '22023',
  'MCP_IDEA_CHALLENGE_EXPIRED',
  'an expired challenge cannot confirm the draft'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  0,
  'expired confirmation does not create human evidence'
);

select is(
  public.confirm_mcp_problem_initial_idea(
    'a5000000-0000-4000-8000-000000000001', repeat('v', 43)
  ) ->> 'idea',
  '我先尝试枚举全部因数。',
  'the owner confirmation stores the exact proposed text'
);
select is(
  (
    select channel_source
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  'mcp',
  'confirmed external evidence has fixed MCP channel provenance'
);
select is(
  (
    select idea_origin
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  'user_confirmed_external',
  'the server fixes the confirmed external evidence origin'
);
select is(
  (
    select revision_kind
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  'set',
  'a confirmed external idea appends a set revision'
);
select is(
  (
    select revision
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'the first confirmed external idea starts at revision one'
);
reset role;
select is(
  (
    select consumed_revision_id is not null
    from public.problem_initial_idea_mcp_challenges
    where id = 'a5000000-0000-4000-8000-000000000001'
  ),
  true,
  'successful confirmation atomically records the consumed revision'
);
select is(
  (
    select consumed_at is not null
    from public.problem_initial_idea_mcp_challenges
    where id = 'a5000000-0000-4000-8000-000000000001'
  ),
  true,
  'successful confirmation marks the challenge consumed'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.confirm_mcp_problem_initial_idea(
      'a5000000-0000-4000-8000-000000000001', repeat('v', 43)
    )$$,
  '55000',
  'MCP_IDEA_CHALLENGE_ALREADY_CONSUMED',
  'a one-time challenge cannot be replayed'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  1,
  'challenge replay cannot append another human revision'
);
select is(
  (
    select semantic_revision
    from public.problems
    where id = 'a3000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'MCP confirmation does not change objective semantic revision'
);
select is(
  (
    select status
    from public.problem_mark_annotations
    where problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  'pending',
  'MCP confirmation does not alter objective annotation state'
);
select is(
  (
    select revision.idea
    from public.problem_user_contexts context
    join public.problem_initial_idea_revisions revision
      on revision.id = context.current_initial_idea_revision_id
    where context.problem_id = 'a3000000-0000-4000-8000-000000000001'
  ),
  '我先尝试枚举全部因数。',
  'the current private head points to the confirmed exact text'
);

reset role;
select lives_ok(
  $$delete from auth.users
    where id = 'a1000000-0000-4000-8000-000000000001'$$,
  'account deletion can purge challenge drafts and confirmed evidence'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_mcp_challenges
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion removes MCP idea challenges'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where user_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion removes confirmed external evidence'
);

select * from finish();
rollback;
