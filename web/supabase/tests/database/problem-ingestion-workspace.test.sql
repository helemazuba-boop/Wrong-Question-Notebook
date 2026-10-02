begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

select has_table(
  'public',
  'problem_ingestion_candidates',
  'problem ingestion candidates table exists'
);
select has_column(
  'public',
  'problem_ingestion_candidates',
  'problem_id',
  'candidate reserves a stable Problem ID'
);
select has_column(
  'public',
  'problem_ingestion_candidates',
  'assets',
  'candidate stores ordered problem assets'
);
select policies_are(
  'public',
  'problem_ingestion_candidates',
  array[
    'problem_ingestion_candidates_owner_select',
    'problem_ingestion_candidates_owner_update'
  ],
  'candidate rows expose only owner select and update policies'
);
select ok(
  has_table_privilege(
    'authenticated',
    'public.problem_ingestion_candidates',
    'SELECT'
  ),
  'authenticated owners may read candidate rows'
);
select is(
  has_table_privilege(
    'authenticated',
    'public.problem_ingestion_candidates',
    'INSERT'
  ),
  false,
  'authenticated callers cannot forge candidate rows'
);

insert into auth.users (id, email)
values
  ('71000000-0000-4000-8000-000000000001', 'ingestion-owner@example.invalid'),
  ('71000000-0000-4000-8000-000000000002', 'ingestion-other@example.invalid');

insert into public.subjects (id, user_id, name)
values (
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  'Ingestion workspace fixture'
);

insert into public.problem_ingestions (
  id,
  user_id,
  subject_id,
  schema_version,
  provider,
  provider_model,
  status,
  document
) values (
  '73000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  'wqn.problem-ingestion.v1',
  'test',
  'test',
  'complete',
  '{"schema_version":"wqn.problem-ingestion.v1","status":"complete","pages":[],"regions":[],"questions":[{"question_id":"question-1"}],"warnings":[]}'::jsonb
);

select is(
  (
    select count(*)::integer
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
  ),
  1,
  'ingestion insert atomically creates one candidate per question'
);
select is(
  (
    select position::integer
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  ),
  1,
  'candidate preserves document question order'
);
select ok(
  (
    select problem_id::text
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  ) is not null,
  'candidate reserves a Problem UUID before image upload'
);

select lives_ok(
  $$
    update public.problem_ingestion_candidates
    set assets = jsonb_build_array(jsonb_build_object(
      'path', 'user/' || user_id || '/problems/' || problem_id ||
        '/problem/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'name', 'figure.png',
      'part_id', null
    ))
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  'a candidate accepts an owned Problem image path'
);
select throws_ok(
  $$
    update public.problem_ingestion_candidates
    set assets = '[{"path":"user/other/problems/other/problem/file","name":"x.png","part_id":null}]'::jsonb
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  '23514',
  'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET_PATH',
  'a candidate rejects a cross-owner or cross-Problem image path'
);
select throws_ok(
  $$
    update public.problem_ingestion_candidates
    set assets = '[{"path":"x","part_id":null}]'::jsonb
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  '23514',
  'INVALID_PROBLEM_INGESTION_CANDIDATE_ASSET',
  'a candidate rejects malformed asset metadata'
);

select throws_ok(
  $$
    update public.problem_ingestion_candidates
    set status = 'accepted'
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  '23514',
  'PROBLEM_INGESTION_CANDIDATE_HAS_NO_PROBLEM_LINK',
  'accepted status cannot be forged before Problem creation'
);

insert into public.problems (
  id,
  user_id,
  subject_id,
  title,
  status,
  parts,
  source
)
select
  candidate.problem_id,
  candidate.user_id,
  '72000000-0000-4000-8000-000000000001',
  'Accepted candidate',
  'needs_review',
  '[{"index":1,"type":"essay"}]'::jsonb,
  jsonb_build_object(
    'ingestion_id', candidate.ingestion_id,
    'ingestion_question_id', candidate.question_id
  )
from public.problem_ingestion_candidates candidate
where candidate.ingestion_id = '73000000-0000-4000-8000-000000000001'
  and candidate.question_id = 'question-1';

select is(
  (
    select count(*)::integer
    from public.problem_ingestion_problem_links
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  ),
  1,
  'Problem insert records the objective ingestion link'
);
select lives_ok(
  $$
    update public.problem_ingestion_candidates
    set status = 'accepted'
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  'candidate becomes accepted after the exact Problem link exists'
);
select is(
  (
    select status
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  ),
  'accepted',
  'accepted workflow state is durable'
);
select throws_ok(
  $$
    update public.problem_ingestion_candidates
    set assets = '[]'::jsonb
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
      and question_id = 'question-1'
  $$,
  '23514',
  'ACCEPTED_PROBLEM_INGESTION_CANDIDATE_IS_IMMUTABLE',
  'an accepted candidate cannot be edited'
);
select throws_ok(
  $$
    delete from public.problem_ingestions
    where id = '73000000-0000-4000-8000-000000000001'
  $$,
  '23503',
  null,
  'accepted ingestion evidence cannot be discarded'
);

select throws_ok(
  $$
    insert into public.problem_ingestions (
      user_id,
      subject_id,
      schema_version,
      provider,
      provider_model,
      status,
      document
    )
    select
      '71000000-0000-4000-8000-000000000001',
      '72000000-0000-4000-8000-000000000001',
      'wqn.problem-ingestion.v1',
      'test',
      'test',
      'complete',
      jsonb_build_object(
        'schema_version', 'wqn.problem-ingestion.v1',
        'status', 'complete',
        'pages', '[]'::jsonb,
        'regions', '[]'::jsonb,
        'questions', (
          select jsonb_agg(jsonb_build_object('question_id', 'q-' || value))
          from generate_series(1, 21) value
        ),
        'warnings', '[]'::jsonb
      )
  $$,
  '23514',
  'PROBLEM_INGESTION_QUESTION_LIMIT_EXCEEDED',
  'more than 20 independent questions are rejected without truncation'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)::integer
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
  ),
  1,
  'owner may read their workspace candidate'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)::integer
    from public.problem_ingestion_candidates
    where ingestion_id = '73000000-0000-4000-8000-000000000001'
  ),
  0,
  'another user cannot read the workspace candidate'
);

select * from finish();

rollback;
