begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Authorization hardening (20260928000000). Two accounts: a victim who owns a
-- problem shared through a public set and one that stays private, and an
-- attacker with a session of their own. Everything the attacker could do
-- through PostgREST is asserted from the attacker's session; the two
-- "planted before the fix" rows are seeded as postgres (the table owner
-- bypasses RLS) so the RPC join pins are exercised on their own, not just via
-- the write policies.

insert into auth.users (id, email)
values
  ('a1000000-0000-4000-8000-000000000001', 'authz-victim@example.invalid'),
  ('a1000000-0000-4000-8000-000000000002', 'authz-attacker@example.invalid');

insert into public.subjects (id, user_id, name)
values
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Victim subject'),
  ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'Attacker subject');

insert into public.problems (id, user_id, subject_id, title, status, parts)
values
  -- Visible to the attacker through the public set below.
  ('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Victim shared problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb),
  -- Never shared: no RLS read path discloses this problem to the attacker.
  ('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Victim private problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb),
  ('c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'Attacker problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb),
  -- Pre-fix plant: a victim-owned problem sitting in the attacker's subject.
  ('c1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'Planted foreign problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb);

insert into public.problem_sets (id, user_id, subject_id, name, sharing_level)
values (
  'f1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'Victim public set',
  'public'
);

insert into public.problem_set_problems (problem_set_id, problem_id, user_id)
values (
  'f1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.attempts (id, user_id, problem_id, submitted_answer)
values
  ('d1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '{}'::jsonb),
  ('d1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', '{}'::jsonb);

insert into public.error_categorisations (
  id, attempt_id, problem_id, subject_id, user_id,
  broad_category, granular_tag, topic_label, topic_label_normalised, ai_confidence
) values (
  'e1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000002',
  'knowledge_gap', 'fixture', 'Fixture topic', 'fixture topic', 0.5
);

-- Pre-fix plant: the attacker scheduled the victim's private problem, which is
-- the enabler the three RPC joins used to trust.
insert into public.review_schedule (user_id, problem_id, next_review_at, interval_days)
values (
  'a1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000002',
  now() - interval '1 day',
  1
);

-- ---------------------------------------------------------------------------
-- Catalog invariants
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'get_due_problems_for_subject',
        'get_due_problems_count',
        'get_subjects_with_metadata'
      )
      and exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
  ),
  3,
  'the three hardened RPCs pin search_path'
);

select policies_are(
  'public',
  'attempts',
  array['attempts_owner_all', 'attempts_problem_owner_read'],
  'attempts exposes only the owner-all and problem-owner-read policies'
);

select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and (tablename, policyname) in (
        ('problem_status_history', 'Users can insert own history'),
        ('error_categorisations', 'Users can update own categorisations'),
        ('problems', 'problems_insert_policy'),
        ('problems', 'problems_update_policy'),
        ('attempts', 'attempts_owner_all'),
        ('review_schedule', 'review_owner_all')
      )
      and with_check ilike '%exists%'
  ),
  6,
  'every hardened write policy carries an ownership check'
);

-- ---------------------------------------------------------------------------
-- Attacker session
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$insert into public.problems (user_id, subject_id, title, status, parts)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'b1000000-0000-4000-8000-000000000001',
      'Forged problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb
    )$$,
  '42501',
  null,
  'a problem cannot be created inside another user''s subject'
);

select lives_ok(
  $$insert into public.problems (user_id, subject_id, title, status, parts)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'b1000000-0000-4000-8000-000000000002',
      'Own problem', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb
    )$$,
  'a problem can still be created inside the caller''s own subject'
);

select throws_ok(
  $$update public.problems
    set subject_id = 'b1000000-0000-4000-8000-000000000001'
    where id = 'c1000000-0000-4000-8000-000000000003'$$,
  '42501',
  null,
  'an owned problem cannot be moved into another user''s subject'
);

select throws_ok(
  $$insert into public.problem_status_history (problem_id, user_id, old_status, new_status)
    values (
      'c1000000-0000-4000-8000-000000000002',
      'a1000000-0000-4000-8000-000000000002',
      'wrong', 'mastered'
    )$$,
  '42501',
  null,
  'status history cannot be planted on another user''s problem'
);

select lives_ok(
  $$insert into public.problem_status_history (problem_id, user_id, old_status, new_status)
    values (
      'c1000000-0000-4000-8000-000000000003',
      'a1000000-0000-4000-8000-000000000002',
      'wrong', 'mastered'
    )$$,
  'status history can still be written for the caller''s own problem'
);

select throws_ok(
  $$update public.error_categorisations
    set attempt_id = 'd1000000-0000-4000-8000-000000000001'
    where id = 'e1000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'a categorisation cannot claim another user''s attempt'
);

select throws_ok(
  $$update public.error_categorisations
    set subject_id = 'b1000000-0000-4000-8000-000000000001'
    where id = 'e1000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'a categorisation cannot be repointed at another user''s subject'
);

select lives_ok(
  $$update public.error_categorisations
    set broad_category = 'careless_mistake'
    where id = 'e1000000-0000-4000-8000-000000000001'$$,
  'the owner can still override their own categorisation'
);

select throws_ok(
  $$insert into public.attempts (user_id, problem_id, submitted_answer)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'c1000000-0000-4000-8000-000000000002',
      '{}'::jsonb
    )$$,
  '42501',
  null,
  'an attempt cannot be planted on a problem the caller cannot see'
);

select lives_ok(
  $$insert into public.attempts (user_id, problem_id, submitted_answer)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'c1000000-0000-4000-8000-000000000001',
      '{}'::jsonb
    )$$,
  'practising a shared problem set still records an attempt'
);

select throws_ok(
  $$insert into public.review_schedule (user_id, problem_id, next_review_at)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'c1000000-0000-4000-8000-000000000002',
      now()
    )$$,
  '42501',
  null,
  'a schedule cannot be planted on a problem the caller cannot see'
);

select lives_ok(
  $$insert into public.review_schedule (user_id, problem_id, next_review_at)
    values (
      'a1000000-0000-4000-8000-000000000002',
      'c1000000-0000-4000-8000-000000000003',
      now()
    )$$,
  'scheduling an owned problem still works'
);

select is_empty(
  $$select * from public.get_due_problems_for_subject('b1000000-0000-4000-8000-000000000001')$$,
  'the planted schedule does not leak the victim''s due problems'
);

select is(
  (
    select count(*)::integer
    from public.get_due_problems_count()
    where subject_id = 'b1000000-0000-4000-8000-000000000001'
  ),
  0,
  'the planted schedule does not leak the victim''s subject id'
);

select is(
  (
    select problem_count::integer
    from public.get_subjects_with_metadata()
    where id = 'b1000000-0000-4000-8000-000000000002'
  ),
  2,
  'both owned problems count, while a foreign planted problem does not'
);

select is(
  (
    select count(*)::integer
    from public.get_subjects_with_metadata()
  ),
  1,
  'get_subjects_with_metadata only lists the caller''s own subjects'
);

-- ---------------------------------------------------------------------------
-- service_role: RPCs read auth.uid() and therefore return nothing without a
-- JWT sub; writes bypass RLS. Both are load-bearing for the app's server-side
-- callers, so they are pinned here.
-- ---------------------------------------------------------------------------

reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is_empty(
  $$select * from public.get_due_problems_for_subject('b1000000-0000-4000-8000-000000000001')$$,
  'service_role without a JWT sub gets an empty due-problems set'
);

select is_empty(
  $$select * from public.get_due_problems_count()$$,
  'service_role without a JWT sub gets an empty due-count set'
);

select lives_ok(
  $$insert into public.problems (user_id, subject_id, title, status, parts)
    values (
      'a1000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002',
      'Service-role write', 'needs_review', '[{"index":1,"type":"short_answer"}]'::jsonb
    )$$,
  'service_role still writes through RLS'
);

select * from finish();

rollback;
