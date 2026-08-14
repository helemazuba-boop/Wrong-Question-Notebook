begin;

select plan(46);

select has_table(
  'public',
  'problem_user_contexts',
  'private per-user Problem context projection exists'
);
select has_table(
  'public',
  'problem_initial_idea_revisions',
  'append-only initial idea revision history exists'
);
select has_column(
  'public',
  'problem_user_contexts',
  'current_initial_idea_revision_id',
  'context points to its current initial idea revision'
);
select policies_are(
  'public',
  'problem_user_contexts',
  array['problem_user_contexts_owner_select'],
  'Problem contexts expose only their owner read policy'
);
select policies_are(
  'public',
  'problem_initial_idea_revisions',
  array['problem_initial_idea_revisions_owner_select'],
  'initial idea revisions expose only their owner read policy'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_user_contexts',
    'SELECT'
  ),
  true,
  'authenticated users may select owner-filtered Problem contexts'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_revisions',
    'SELECT'
  ),
  true,
  'authenticated users may select owner-filtered initial idea revisions'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_user_contexts',
    'INSERT'
  ),
  false,
  'authenticated users cannot insert context heads directly'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_revisions',
    'INSERT'
  ),
  false,
  'authenticated users cannot insert initial idea revisions directly'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_revisions',
    'UPDATE'
  ),
  false,
  'authenticated users cannot rewrite initial idea revisions'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_initial_idea_revisions',
    'DELETE'
  ),
  false,
  'authenticated users cannot delete initial idea revisions'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.set_problem_initial_idea(uuid,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated users may execute the constrained initial idea RPC'
);
select is(
  has_function_privilege(
    'anon',
    'public.set_problem_initial_idea(uuid,text,text)',
    'EXECUTE'
  ),
  false,
  'anonymous users cannot execute the initial idea RPC'
);
select is(
  (
    select p.prosecdef
    from pg_proc p
    where p.oid =
      'private.append_web_problem_initial_idea_revision(uuid,text,text)'::regprocedure
  ),
  true,
  'the private writer owns the atomic privileged transaction'
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
      'private.append_web_problem_initial_idea_revision(uuid,text,text)'::regprocedure
  ),
  true,
  'the private SECURITY DEFINER writer has an empty search path'
);
select is(
  (
    select count(*)::integer
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    where p.oid =
      'private.append_web_problem_initial_idea_revision(uuid,text,text)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'the private SECURITY DEFINER writer is not executable by PUBLIC'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    'f1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'initial-idea-owner@example.invalid',
    '',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'initial-idea-viewer@example.invalid',
    '',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.subjects (id, user_id, name, color, icon)
values (
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  'Initial idea isolation',
  'amber',
  'NotebookPen'
);

insert into public.problems (
  id,
  user_id,
  subject_id,
  title,
  content,
  assets,
  solution_assets,
  status,
  parts,
  source,
  is_optional
) values (
  'f3000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'Initial idea isolation fixture',
  'Objective Problem content',
  '[]'::jsonb,
  '[]'::jsonb,
  'needs_review',
  '[{"index":1,"type":"short_answer"}]'::jsonb,
  '{}'::jsonb,
  false
);

insert into public.problem_sets (
  id,
  user_id,
  subject_id,
  name,
  sharing_level,
  is_smart,
  allow_copying,
  is_listed,
  type
) values (
  'f4000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'Public initial idea isolation fixture',
  'public',
  false,
  true,
  true,
  'manual'
);

insert into public.problem_set_problems (
  id,
  problem_set_id,
  problem_id,
  user_id
) values (
  'f5000000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001'
);

create temporary table initial_idea_objective_snapshot on commit drop as
select
  problem.semantic_revision,
  annotation.status as annotation_status,
  annotation.updated_at as annotation_updated_at
from public.problems problem
join public.problem_mark_annotations annotation
  on annotation.problem_id = problem.id
where problem.id = 'f3000000-0000-4000-8000-000000000001';

grant select on initial_idea_objective_snapshot to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated","email":"initial-idea-owner@example.invalid"}',
  true
);

select is(
  public.set_problem_initial_idea(
    'f3000000-0000-4000-8000-000000000001',
    'set',
    '我先尝试了配方法。'
  ) ->> 'replayed',
  'false',
  'the first set appends a new current revision'
);
select is(
  (
    select revision
    from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'the first initial idea starts at revision one'
);
select is(
  (
    select revision.idea
    from public.problem_user_contexts context
    join public.problem_initial_idea_revisions revision
      on revision.id = context.current_initial_idea_revision_id
    where context.problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '我先尝试了配方法。',
  'the private head resolves to the exact user text'
);
select is(
  (
    select channel_source
    from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  'web',
  'the Web RPC fixes channel provenance server-side'
);
select is(
  (
    select idea_origin
    from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  'user_typed',
  'the Web RPC fixes human evidence origin server-side'
);
select is(
  (
    select semantic_revision
    from public.problems
    where id = 'f3000000-0000-4000-8000-000000000001'
  ),
  (select semantic_revision from initial_idea_objective_snapshot),
  'setting an idea does not change objective semantic revision'
);
select is(
  (
    select status
    from public.problem_mark_annotations
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  (select annotation_status from initial_idea_objective_snapshot),
  'setting an idea does not change Problem Mark annotation status'
);
select is(
  (
    select updated_at
    from public.problem_mark_annotations
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  (select annotation_updated_at from initial_idea_objective_snapshot),
  'setting an idea does not touch Problem Mark annotation state'
);
select is(
  public.set_problem_initial_idea(
    'f3000000-0000-4000-8000-000000000001',
    'set',
    '我先尝试了配方法。'
  ) ->> 'replayed',
  'true',
  'an identical retry reuses the current revision'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  1,
  'an identical retry does not duplicate history'
);
select is(
  public.set_problem_initial_idea(
    'f3000000-0000-4000-8000-000000000001',
    'clear',
    null
  ) ->> 'revision',
  '2',
  'an explicit clear appends the next revision'
);
select is(
  (
    select revision.revision_kind
    from public.problem_user_contexts context
    join public.problem_initial_idea_revisions revision
      on revision.id = context.current_initial_idea_revision_id
    where context.problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  'clear',
  'the current head records an explicit clear'
);
select is(
  (
    select revision.idea
    from public.problem_user_contexts context
    join public.problem_initial_idea_revisions revision
      on revision.id = context.current_initial_idea_revision_id
    where context.problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  null,
  'an explicit clear stores SQL NULL rather than an empty string'
);
select throws_ok(
  $$select public.set_problem_initial_idea(
      'f3000000-0000-4000-8000-000000000001', 'set', ''
    )$$,
  '22023',
  'INVALID_INITIAL_IDEA_REVISION',
  'empty text cannot masquerade as an initial idea clear'
);
select throws_ok(
  $$select public.set_problem_initial_idea(
      'f3000000-0000-4000-8000-000000000001', 'clear', 'not null'
    )$$,
  '22023',
  'INVALID_INITIAL_IDEA_REVISION',
  'clear requires a null idea'
);
select throws_ok(
  $$select public.set_problem_initial_idea(
      'f3000000-0000-4000-8000-000000000001', 'replace', 'forbidden'
    )$$,
  '22023',
  'INVALID_INITIAL_IDEA_REVISION',
  'only set and clear revision kinds are accepted'
);
select throws_ok(
  $$insert into public.problem_initial_idea_revisions (
      user_id, problem_id, revision, revision_kind, idea,
      channel_source, idea_origin
    ) values (
      'f1000000-0000-4000-8000-000000000001',
      'f3000000-0000-4000-8000-000000000001',
      3, 'set', 'forged', 'web', 'user_typed'
    )$$,
  '42501',
  null,
  'authenticated users cannot bypass the append RPC'
);
select throws_ok(
  $$update public.problem_initial_idea_revisions
    set idea = 'rewritten'
    where problem_id = 'f3000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'authenticated users cannot update revision history directly'
);
select throws_ok(
  $$delete from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'authenticated users cannot delete revision history directly'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated","email":"initial-idea-viewer@example.invalid"}',
  true
);
select is(
  (
    select count(*)::integer
    from public.problems
    where id = 'f3000000-0000-4000-8000-000000000001'
  ),
  1,
  'a shared viewer can read the public objective Problem'
);
select is(
  (
    select count(*)::integer
    from public.problem_user_contexts
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  0,
  'a shared viewer cannot read the owner personal context'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  0,
  'a shared viewer cannot read the owner initial idea history'
);
select throws_ok(
  $$select public.set_problem_initial_idea(
      'f3000000-0000-4000-8000-000000000001', 'set', 'viewer forgery'
    )$$,
  '42501',
  'PROBLEM_NOT_OWNED',
  'a shared viewer cannot attach personal evidence to another owner Problem'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select * from public.problem_user_contexts$$,
  '42501',
  null,
  'anonymous users cannot read private Problem contexts'
);

reset role;
set local role service_role;
select lives_ok(
  $$delete from public.problem_initial_idea_revisions
    where problem_id = 'f3000000-0000-4000-8000-000000000001'$$,
  'a privileged privacy purge may physically delete revision history'
);
select is(
  (
    select current_initial_idea_revision_id
    from public.problem_user_contexts
    where problem_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  null,
  'privacy purge nulls the current head without deleting its context row'
);

reset role;
select lives_ok(
  $$delete from auth.users
    where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'account deletion cascades through personal initial idea data'
);
select is(
  (
    select count(*)::integer
    from public.problem_user_contexts
    where user_id = 'f1000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion removes private Problem contexts'
);
select is(
  (
    select count(*)::integer
    from public.problem_initial_idea_revisions
    where user_id = 'f1000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion removes initial idea revision history'
);
select is(
  (
    select count(*)::integer
    from public.problems
    where user_id = 'f1000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion still cascades through the objective owner Problem'
);

select * from finish();
rollback;
