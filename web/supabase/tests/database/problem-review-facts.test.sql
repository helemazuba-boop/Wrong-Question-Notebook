begin;

select plan(73);

insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'review-owner@example.test'),
  ('10000000-0000-4000-8000-000000000002', 'review-other@example.test');

insert into public.subjects (id, user_id, name)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Owner subject'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'Other subject'
  );

insert into public.problems (id, user_id, subject_id, title, status, parts)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'Owner problem',
    'needs_review',
    '[{"index":1,"type":"short_answer"}]'::jsonb
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'Other problem',
    'needs_review',
    '[{"index":1,"type":"short_answer"}]'::jsonb
  );

insert into public.problem_user_contexts (user_id, problem_id)
values (
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001'
);

insert into public.problem_initial_idea_revisions (
  id,
  user_id,
  problem_id,
  revision,
  revision_kind,
  idea,
  channel_source,
  idea_origin
) values (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  1,
  'set',
  'I started by separating the parameter.',
  'web',
  'user_typed'
);

update public.problem_user_contexts
set current_initial_idea_revision_id =
      '40000000-0000-4000-8000-000000000001'
where user_id = '10000000-0000-4000-8000-000000000001'
  and problem_id = '30000000-0000-4000-8000-000000000001';

select has_table(
  'public',
  'problem_review_occurrences',
  'has stable Review occurrence table'
);
select has_table(
  'public',
  'problem_review_events',
  'has immutable Review Event table'
);
select has_table(
  'public',
  'problem_review_idea_revisions',
  'has append-only Review idea table'
);
select has_table(
  'public',
  'problem_review_projection_jobs',
  'has durable dirty projection job table'
);
select has_view(
  'public',
  'effective_problem_review_events',
  'has effective Review Event stream view'
);

select is(
  (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'problem_review_events'
  ),
  true,
  'Review Events have RLS enabled'
);
select is(
  (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'problem_review_idea_revisions'
  ),
  true,
  'Review idea revisions have RLS enabled'
);
select is(
  (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'problem_review_projection_jobs'
  ),
  true,
  'projection jobs have RLS enabled'
);
select is(
  (
    select c.reloptions @> array['security_invoker=true']
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'effective_problem_review_events'
  ),
  true,
  'effective Review view is security invoker'
);

select is(
  has_table_privilege('authenticated', 'public.problem_review_events', 'SELECT'),
  true,
  'authenticated may read owned Review Events'
);
select is(
  has_table_privilege('authenticated', 'public.problem_review_events', 'INSERT'),
  false,
  'authenticated cannot insert Review Events directly'
);
select is(
  has_table_privilege('authenticated', 'public.problem_review_events', 'UPDATE'),
  false,
  'authenticated cannot update Review Events directly'
);
select is(
  has_table_privilege('authenticated', 'public.problem_review_events', 'DELETE'),
  false,
  'authenticated cannot delete Review Events directly'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_review_projection_jobs',
    'SELECT'
  ),
  false,
  'browser role cannot read projection jobs'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_review_projection_jobs',
    'INSERT'
  ),
  false,
  'browser role cannot mutate projection jobs'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.record_problem_review_fact(uuid,uuid,uuid,uuid,uuid,text,text,boolean,text,uuid,text,timestamptz,uuid,uuid)',
    'EXECUTE'
  ),
  false,
  'browser role cannot forge Review facts through service RPC'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.set_problem_review_idea(uuid,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated user may append an owned Web Review idea'
);
select is(
  has_function_privilege(
    'anon',
    'public.set_problem_review_idea(uuid,text,text)',
    'EXECUTE'
  ),
  false,
  'anonymous user cannot append Review ideas'
);
select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'record_problem_review_fact'
  ),
  true,
  'private Review fact writer is SECURITY DEFINER'
);
select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'record_problem_review_fact'
  ),
  array['search_path=""'],
  'private Review fact writer has an empty search path'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Good',
      false,
      'web',
      null,
      'review-request-0001',
      '2026-08-08 08:00:00+00',
      '40000000-0000-4000-8000-000000000001',
      null
    )
  $$,
  'service writer records an initial Rating fact'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  1,
  'initial Rating produces one Event'
);
select is(
  (
    select human_rating
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000001'
  ),
  'Good',
  'human Rating is stored independently from machine correctness'
);
select is(
  (
    select machine_correctness_snapshot
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000001'
  ),
  false,
  'machine correctness remains a nullable snapshot, not Rating authority'
);
select is(
  (
    select initial_idea_revision_id
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000001'
  ),
  '40000000-0000-4000-8000-000000000001'::uuid,
  'Event pins the initial idea revision visible at Rating time'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
  ),
  1,
  'Event transaction durably marks the timeline dirty'
);
select is(
  (
    select dirty_from
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
  ),
  '2026-08-08 08:00:00+00'::timestamptz,
  'dirty boundary starts at effective Review time'
);
select is(
  (
    select count(*)::integer
    from public.review_schedule
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
  ),
  0,
  'new fact writer does not cut over current SM-2 authority'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Good',
      false,
      'web',
      null,
      'review-request-0001',
      '2026-08-08 08:00:00+00',
      '40000000-0000-4000-8000-000000000001',
      null
    )
  $$,
  'identical actor request replay succeeds'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where source_request_id = 'review-request-0001'
  ),
  1,
  'request replay does not duplicate Review Events'
);

select lives_ok(
  $$
    delete from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001';
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Good',
      false,
      'web',
      null,
      'review-request-0001',
      '2026-08-08 08:00:00+00',
      '40000000-0000-4000-8000-000000000001',
      null
    )
  $$,
  'request replay repairs a missing dirty job'
);
select is(
  (
    select dirty_from
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
  ),
  '2026-08-08 08:00:00+00'::timestamptz,
  'repaired dirty job retains the effective Review boundary'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Hard',
      true,
      'web',
      null,
      'review-request-0002',
      '2026-08-07 06:00:00+00',
      null,
      null
    )
  $$,
  'late Review Event is accepted as a separate occurrence'
);
select is(
  (
    select dirty_from
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
  ),
  '2026-08-07 06:00:00+00'::timestamptz,
  'late Review uses least(existing dirty_from, event time)'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000003',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Hard',
      true,
      'web',
      null,
      'review-correction-01',
      '2026-08-08 09:00:00+00',
      null,
      '50000000-0000-4000-8000-000000000001'
    )
  $$,
  'Rating correction appends within the same occurrence'
);
select is(
  (
    select reviewed_at
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000003'
  ),
  '2026-08-08 08:00:00+00'::timestamptz,
  'correction inherits original reviewed_at'
);
select is(
  (
    select effective_review_at
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000003'
  ),
  '2026-08-08 08:00:00+00'::timestamptz,
  'correction inherits original effective_review_at'
);
select is(
  (
    select count(*)::integer
    from public.effective_problem_review_events
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  1,
  'supersession leaves one effective Event for the occurrence'
);
select is(
  (
    select human_rating
    from public.effective_problem_review_events
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  'Hard',
  'effective Event stream exposes the corrected human Rating'
);

select lives_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000004',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Easy',
      false,
      'web',
      null,
      'review-correction-02',
      '2026-08-08 12:00:00+00',
      null,
      '50000000-0000-4000-8000-000000000003'
    )
  $$,
  'a later correction supersedes the current occurrence head'
);
select is(
  (
    select reviewed_at
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000004'
  ),
  '2026-08-08 08:00:00+00'::timestamptz,
  'multi-step correction retains original reviewed_at'
);
select is(
  (
    select count(*)::integer
    from public.effective_problem_review_events
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  1,
  'multi-step correction chain still has one effective Event'
);
select is(
  (
    select human_rating
    from public.effective_problem_review_events
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  'Easy',
  'terminal correction becomes the effective human Rating'
);

select lives_ok(
  $$
    set local role authenticated;
    select set_config(
      'request.jwt.claim.sub',
      '10000000-0000-4000-8000-000000000001',
      true
    );
    select public.set_problem_review_idea(
      '60000000-0000-4000-8000-000000000001',
      'set',
      'I remembered the method but rushed the sign.'
    );
    reset role;
  $$,
  'owner appends an exact Web Review idea after Rating'
);
select is(
  (
    select idea
    from public.problem_review_idea_revisions
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
      and revision = 1
  ),
  'I remembered the method but rushed the sign.',
  'Review idea preserves exact human text'
);
select is(
  (
    select review_occurrence_id
    from public.problem_review_idea_revisions
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
      and revision = 1
  ),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'Review idea remains linked to the stable occurrence'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_idea_revisions
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
  ),
  1,
  'Rating correction does not copy or migrate Review idea'
);

select lives_ok(
  $$
    set local role authenticated;
    select set_config(
      'request.jwt.claim.sub',
      '10000000-0000-4000-8000-000000000001',
      true
    );
    select public.set_problem_review_idea(
      '60000000-0000-4000-8000-000000000001',
      'clear',
      null
    );
    reset role;
  $$,
  'owner clears Review idea with an append-only revision'
);
select is(
  (
    select revision_kind
    from public.problem_review_idea_revisions
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
    order by revision desc
    limit 1
  ),
  'clear',
  'latest Review idea revision records clear explicitly'
);
select is(
  (
    select idea
    from public.problem_review_idea_revisions
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
    order by revision desc
    limit 1
  ),
  null,
  'clear Review idea stores SQL NULL'
);

select throws_ok(
  $$
    update public.problem_review_events
    set human_rating = 'Easy'
    where id = '50000000-0000-4000-8000-000000000003'
  $$,
  '55000',
  'PROBLEM_REVIEW_EVENTS_APPEND_ONLY',
  'Review Events cannot be rewritten'
);
select throws_ok(
  $$
    update public.problem_review_occurrences
    set reviewed_at = '2026-08-01 00:00:00+00'
    where id = '60000000-0000-4000-8000-000000000001'
  $$,
  '55000',
  'PROBLEM_REVIEW_OCCURRENCES_APPEND_ONLY',
  'Review occurrence identity and timing cannot be rewritten'
);
select throws_ok(
  $$
    update public.problem_review_idea_revisions
    set idea = 'rewritten'
    where review_occurrence_id = '60000000-0000-4000-8000-000000000001'
      and revision = 1
  $$,
  '55000',
  'PROBLEM_REVIEW_IDEA_REVISIONS_APPEND_ONLY',
  'Review idea revisions cannot be rewritten'
);
select throws_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000006',
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      null,
      'review',
      'Again',
      false,
      'web',
      null,
      'review-correction-03',
      '2026-08-08 08:00:00+00',
      null,
      '50000000-0000-4000-8000-000000000003'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "problem_review_events_supersedes_uidx"',
  'supersession cannot fork from an Event with an existing successor'
);
select throws_ok(
  $$
    select public.record_problem_review_fact(
      '50000000-0000-4000-8000-000000000005',
      '60000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      null,
      'review',
      'Good',
      true,
      'web',
      null,
      'review-request-0003',
      '2026-08-08 10:00:00+00',
      null,
      null
    )
  $$,
  '42501',
  'REVIEW_PROBLEM_NOT_OWNED',
  'Review writer enforces Problem ownership'
);

select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where id = '50000000-0000-4000-8000-000000000005'
  ),
  0,
  'failed fact transaction leaves no Event'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_occurrences
    where id = '60000000-0000-4000-8000-000000000003'
  ),
  0,
  'failed fact transaction leaves no occurrence shell'
);

update public.user_profiles
set username = 'review-owner', timezone = 'UTC'
where id = '10000000-0000-4000-8000-000000000001';
insert into public.esp32_devices (
  id,
  user_id,
  mac_address,
  access_token_hash
) values (
  '70000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'AA:BB:CC:DD:EE:01',
  repeat('a', 64)
);

select lives_ok(
  $$
    select public.record_problem_review_v1(
      '10000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      'compat-review-0001',
      '30000000-0000-4000-8000-000000000001',
      'correct',
      '2026-08-08 11:00:00+00'
    )
  $$,
  'legacy device RPC records the immutable human Review fact'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_observations
    where request_id = 'compat-review-0001'
  ),
  1,
  'legacy RPC records one compatibility observation'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where source_request_id = 'compat-review-0001'
  ),
  1,
  'legacy observation trigger atomically mirrors one immutable Event'
);
select is(
  (
    select review_occurrence_id
    from public.problem_review_events
    where source_request_id = 'compat-review-0001'
  ),
  (
    select id
    from public.problem_review_observations
    where request_id = 'compat-review-0001'
  ),
  'legacy observation id becomes the stable occurrence id'
);
select is(
  (
    select human_rating
    from public.problem_review_events
    where source_request_id = 'compat-review-0001'
  ),
  'Good',
  'legacy correct maps to human Good compatibility Rating'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
      and problem_id = '30000000-0000-4000-8000-000000000001'
      and status = 'pending'
  ),
  1,
  'legacy Review queues event-driven scheduler projection'
);
select is(
  (
    select status::text
    from public.problems
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  'needs_review',
  'legacy fact ingestion does not synchronously overwrite projected Problem status'
);
select is(
  (
    select last_reviewed_date
    from public.problems
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  null::timestamptz,
  'legacy fact ingestion leaves projected last reviewed time unchanged'
);
select lives_ok(
  $$
    select public.record_problem_review_v1(
      '10000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      'compat-review-0001',
      '30000000-0000-4000-8000-000000000001',
      'correct',
      '2026-08-08 11:00:00+00'
    )
  $$,
  'legacy RPC retry remains idempotent after immutable mirror'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where source_request_id = 'compat-review-0001'
  ),
  1,
  'legacy retry does not duplicate immutable Events'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where user_id = '10000000-0000-4000-8000-000000000001'
  ),
  5,
  'owner RLS reads owned Review Events'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where user_id = '10000000-0000-4000-8000-000000000002'
  ),
  0,
  'owner RLS cannot read another user Review Events'
);
reset role;

select lives_ok(
  $$
    delete from auth.users
    where id = '10000000-0000-4000-8000-000000000001'
  $$,
  'account deletion may purge immutable personal Review facts'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_events
    where user_id = '10000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion purges Review Events'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_idea_revisions
    where user_id = '10000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion purges Review ideas'
);
select is(
  (
    select count(*)::integer
    from public.problem_review_projection_jobs
    where user_id = '10000000-0000-4000-8000-000000000001'
  ),
  0,
  'account deletion purges projection jobs'
);

select * from finish();

rollback;
