begin;

select plan(95);

select has_table(
  'public',
  'canonical_subjects',
  'canonical subjects runtime projection exists'
);
select has_table(
  'public',
  'knowledge_marks',
  'knowledge marks runtime projection exists'
);
select has_table(
  'public',
  'problem_marks',
  'problem mark relationship exists'
);
select has_column(
  'public',
  'subjects',
  'canonical_subject_key',
  'user subjects expose their canonical classification hint'
);
select col_is_pk(
  'public',
  'canonical_subjects',
  'stable_key',
  'canonical subject stable key is the identity'
);
select col_is_pk(
  'public',
  'knowledge_marks',
  'stable_key',
  'mark stable key is the identity'
);
select policies_are(
  'public',
  'canonical_subjects',
  array['canonical_subjects_authenticated_select'],
  'canonical subjects have only the authenticated read policy'
);
select policies_are(
  'public',
  'knowledge_marks',
  array['knowledge_marks_authenticated_select'],
  'knowledge marks have only the authenticated read policy'
);
select policies_are(
  'public',
  'problem_marks',
  array['problem_marks_visible_problem_select'],
  'problem marks reuse problem visibility'
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
    'a0000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'knowledge-marks-owner@example.invalid',
    '',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'knowledge-marks-viewer@example.invalid',
    '',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.subjects (id, user_id, name, color, icon)
values
  (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '数学',
    'blue',
    'Calculator'
  ),
  (
    'b0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001',
    '数学',
    'blue',
    'Calculator'
  ),
  (
    'b0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    '未分类',
    'amber',
    'NotebookPen'
  ),
  (
    'b0000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000001',
    '函数专题',
    'blue',
    'Calculator'
  ),
  (
    'b0000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000001',
    '物理',
    'purple',
    'Atom'
  );

select is(
  (
    select count(*)::integer
    from public.subjects
    where user_id = 'a0000000-0000-4000-8000-000000000001'
      and canonical_subject_key = 'math'
  ),
  2,
  'duplicate user-owned subject containers can map to math'
);
select is(
  (
    select canonical_subject_key
    from public.subjects
    where id = 'b0000000-0000-4000-8000-000000000001'
  ),
  'math',
  'exact preset names map at database insertion time'
);
select is(
  (
    select canonical_subject_key
    from public.subjects
    where id = 'b0000000-0000-4000-8000-000000000003'
  ),
  null,
  'uncategorised remains unmapped'
);
select is(
  (
    select canonical_subject_key
    from public.subjects
    where id = 'b0000000-0000-4000-8000-000000000004'
  ),
  null,
  'custom user subject names remain unmapped'
);

update public.subjects
set name = '高三数学'
where id = 'b0000000-0000-4000-8000-000000000001';

select is(
  (
    select canonical_subject_key
    from public.subjects
    where id = 'b0000000-0000-4000-8000-000000000001'
  ),
  'math',
  'renaming a subject does not erase its established classification'
);

select is(
  public.sync_knowledge_registry(
    $$[
      {"stable_key":"chinese","name":"语文","aliases":["Chinese"],"status":"active"},
      {"stable_key":"math","name":"数学","aliases":["Mathematics"],"status":"active"},
      {"stable_key":"english","name":"英语","aliases":["English","English Vocabulary"],"status":"active"},
      {"stable_key":"physics","name":"物理","aliases":["Physics"],"status":"active"},
      {"stable_key":"chemistry","name":"化学","aliases":["Chemistry"],"status":"active"},
      {"stable_key":"biology","name":"生物","aliases":["Biology"],"status":"active"},
      {"stable_key":"history","name":"历史","aliases":["History"],"status":"active"},
      {"stable_key":"geography","name":"地理","aliases":["Geography"],"status":"active"},
      {"stable_key":"politics","name":"政治","aliases":["Politics"],"status":"active"},
      {"stable_key":"information_technology","name":"信息技术","aliases":["Information Technology"],"status":"active"},
      {"stable_key":"other","name":"其他","aliases":["Other"],"status":"active"}
    ]$$::jsonb,
    $$[
      {"stable_key":"math.knowledge.function","name":"函数","kind":"knowledge","subject":"math","aliases":[],"include":[],"exclude":[],"status":"active"},
      {"stable_key":"math.knowledge.function.extremum","name":"函数极值","kind":"knowledge","subject":"math","aliases":[],"parent":"math.knowledge.function","include":["求极值"],"exclude":[],"status":"active"},
      {"stable_key":"math.skill.parameter_separation","name":"参变分离","kind":"skill","subject":"math","aliases":[],"include":[],"exclude":[],"status":"active"},
      {"stable_key":"physics.knowledge.kinematics","name":"运动学","kind":"knowledge","subject":"physics","aliases":[],"include":[],"exclude":[],"status":"active"}
    ]$$::jsonb
  ),
  '{"marks": 4, "subjects": 11}'::jsonb,
  'service-owned registry sync projects reviewed definitions atomically'
);
select is(
  (
    select parent_key
    from public.knowledge_marks
    where stable_key = 'math.knowledge.function.extremum'
  ),
  'math.knowledge.function',
  'registry sync resolves parents independent of input ordering'
);
select is(
  (
    select status
    from public.knowledge_marks
    where stable_key = 'math.skill.parameter_separation'
  ),
  'active',
  'registry sync stores only active or deprecated runtime status'
);

select throws_ok(
  $$select public.sync_knowledge_registry(
    '[{"stable_key":"math","name":"数学","aliases":[],"status":"active"}]'::jsonb,
    '[]'::jsonb
  )$$,
  '22023',
  'REGISTRY_SUBJECT_REMOVAL_FORBIDDEN',
  'sync refuses to remove canonical subject identities'
);
select throws_ok(
  $query$select public.sync_knowledge_registry(
    $$[
      {"stable_key":"chinese","name":"语文","aliases":[],"status":"active"},
      {"stable_key":"math","name":"数学","aliases":[],"status":"active"},
      {"stable_key":"english","name":"英语","aliases":[],"status":"active"},
      {"stable_key":"physics","name":"物理","aliases":[],"status":"active"},
      {"stable_key":"chemistry","name":"化学","aliases":[],"status":"active"},
      {"stable_key":"biology","name":"生物","aliases":[],"status":"active"},
      {"stable_key":"history","name":"历史","aliases":[],"status":"active"},
      {"stable_key":"geography","name":"地理","aliases":[],"status":"active"},
      {"stable_key":"politics","name":"政治","aliases":[],"status":"active"},
      {"stable_key":"information_technology","name":"信息技术","aliases":[],"status":"active"},
      {"stable_key":"other","name":"其他","aliases":[],"status":"active"}
    ]$$::jsonb,
    '[]'::jsonb
  )$query$,
  '22023',
  'REGISTRY_MARK_REMOVAL_FORBIDDEN',
  'sync refuses to remove canonical mark identities'
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
) values
  (
    'c0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
    'Knowledge Mark fixture',
    'Fixture content',
    '[]'::jsonb,
    '[]'::jsonb,
    'needs_review',
    '[
      {"index":1,"type":"short_answer"},
      {"index":2,"type":"essay"}
    ]'::jsonb,
    '{}'::jsonb,
    false
  ),
  (
    'c0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000003',
    'Unmapped subject fixture',
    'Fixture content',
    '[]'::jsonb,
    '[]'::jsonb,
    'needs_review',
    '[{"index":1,"type":"short_answer"}]'::jsonb,
    '{}'::jsonb,
    false
  );

select lives_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values
      ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function', 'target', null),
      ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function.extremum', 'target', 1),
      ('c0000000-0000-4000-8000-000000000001', 'math.skill.parameter_separation', 'required', 2)$$,
  'valid shell and part relationships are accepted'
);
select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000001'
  ),
  3,
  'shell and part relationships are stored independently'
);
select is(
  (
    select role
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000001'
      and mark_key = 'math.skill.parameter_separation'
      and part_index = 2
  ),
  'required',
  'part-level relationship retains its role'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function', 'required', null)$$,
  '23505',
  null,
  'shell-level NULL participates in relationship uniqueness'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function.extremum', 'required', 1)$$,
  '23505',
  null,
  'part-level duplicate cannot carry a conflicting role'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function', 'related', null)$$,
  '23514',
  null,
  'relationship role is restricted to target or required'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.knowledge.function', 'required', 3)$$,
  '23514',
  'PROBLEM_MARK_PART_NOT_FOUND',
  'part relationship must point to an existing problem part'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'physics.knowledge.kinematics', 'required', 1)$$,
  '23514',
  'PROBLEM_MARK_SUBJECT_MISMATCH',
  'problem and mark canonical subjects must match'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000002', 'math.knowledge.function', 'target', null)$$,
  '23514',
  'PROBLEM_MARK_SUBJECT_UNMAPPED',
  'unmapped user subjects cannot carry canonical marks'
);

update public.problems
set status = 'wrong'
where id = 'c0000000-0000-4000-8000-000000000001';

select pass('non-semantic problem edits remain authoritative despite derived marks');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated","email":"knowledge-marks-owner@example.invalid"}',
  true
);

select is(
  (
    select count(*)::integer
    from public.canonical_subjects
  ),
  11,
  'authenticated users can read the canonical subject registry'
);
select is(
  (
    select count(*)::integer
    from public.knowledge_marks
  ),
  4,
  'authenticated users can read the canonical mark registry'
);
select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000001'
  ),
  3,
  'problem owner can read derived marks'
);
select throws_ok(
  $$insert into public.canonical_subjects (stable_key, name, status)
    values ('forged', '伪造', 'active')$$,
  '42501',
  null,
  'authenticated users cannot write canonical subjects'
);
select throws_ok(
  $$insert into public.knowledge_marks (
      stable_key, subject_key, kind, name, status
    ) values (
      'math.skill.forged', 'math', 'skill', '伪造', 'active'
    )$$,
  '42501',
  null,
  'authenticated users cannot write canonical marks'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.skill.parameter_separation', 'required', null)$$,
  '42501',
  null,
  'authenticated users cannot write problem marks'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.sync_knowledge_registry(jsonb,jsonb)',
    'EXECUTE'
  ),
  false,
  'authenticated users cannot execute Registry synchronization'
);
select throws_ok(
  $$insert into public.subjects (
      user_id, name, color, icon, canonical_subject_key
    ) values (
      'a0000000-0000-4000-8000-000000000001',
      '自定义数学',
      'blue',
      'Calculator',
      'math'
    )$$,
  '42501',
  'CANONICAL_SUBJECT_KEY_MANAGED',
  'authenticated users cannot choose a canonical key during insertion'
);
select throws_ok(
  $$update public.subjects
    set canonical_subject_key = 'physics'
    where id = 'b0000000-0000-4000-8000-000000000002'$$,
  '42501',
  'CANONICAL_SUBJECT_KEY_MANAGED',
  'authenticated users cannot change an established canonical key'
);
select lives_ok(
  $$insert into public.subjects (user_id, name, color, icon)
    values (
      'a0000000-0000-4000-8000-000000000001',
      '化学',
      'orange',
      'Beaker'
    )$$,
  'authenticated subject creation can omit the managed key'
);
select is(
  (
    select canonical_subject_key
    from public.subjects
    where user_id = 'a0000000-0000-4000-8000-000000000001'
      and name = '化学'
    order by created_at desc
    limit 1
  ),
  'chemistry',
  'database maps exact preset names after authenticated insertion'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated","email":"knowledge-marks-viewer@example.invalid"}',
  true
);

select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000001'
  ),
  0,
  'unshared authenticated users cannot read another user problem marks'
);

reset role;
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
  'd0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'Public Knowledge Mark fixture',
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
  'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated","email":"knowledge-marks-viewer@example.invalid"}',
  true
);
select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000001'
  ),
  3,
  'authenticated users can read marks for shared visible problems'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select * from public.canonical_subjects$$,
  '42501',
  null,
  'anonymous users cannot read canonical subjects'
);
select throws_ok(
  $$select * from public.knowledge_marks$$,
  '42501',
  null,
  'anonymous users cannot read canonical marks'
);
select throws_ok(
  $$select * from public.problem_marks$$,
  '42501',
  null,
  'anonymous users cannot read problem marks'
);
select throws_ok(
  $$insert into public.problem_marks (problem_id, mark_key, role, part_index)
    values ('c0000000-0000-4000-8000-000000000001', 'math.skill.parameter_separation', 'required', null)$$,
  '42501',
  null,
  'anonymous users cannot write problem marks'
);

reset role;

create temporary table registry_revision_fixture (artifact_text text not null);
insert into registry_revision_fixture values ($artifact${"schema_version":1,"subjects":[{"stable_key":"chinese","name":"语文","aliases":["Chinese"],"status":"active"},{"stable_key":"math","name":"数学","aliases":["Mathematics"],"status":"active"},{"stable_key":"english","name":"英语","aliases":["English","English Vocabulary"],"status":"active"},{"stable_key":"physics","name":"物理","aliases":["Physics"],"status":"active"},{"stable_key":"chemistry","name":"化学","aliases":["Chemistry"],"status":"active"},{"stable_key":"biology","name":"生物","aliases":["Biology"],"status":"active"},{"stable_key":"history","name":"历史","aliases":["History"],"status":"active"},{"stable_key":"geography","name":"地理","aliases":["Geography"],"status":"active"},{"stable_key":"politics","name":"政治","aliases":["Politics"],"status":"active"},{"stable_key":"information_technology","name":"信息技术","aliases":["Information Technology"],"status":"active"},{"stable_key":"other","name":"其他","aliases":["Other"],"status":"active"}],"marks":[{"stable_key":"math.knowledge.function","name":"函数","kind":"knowledge","subject":"math","aliases":[],"include":[],"exclude":[],"status":"active"},{"stable_key":"math.knowledge.function.extremum","name":"函数极值","kind":"knowledge","subject":"math","aliases":[],"parent":"math.knowledge.function","include":["求极值"],"exclude":[],"status":"active"},{"stable_key":"math.skill.parameter_separation","name":"参变分离","kind":"skill","subject":"math","aliases":[],"include":[],"exclude":[],"status":"active"},{"stable_key":"physics.knowledge.kinematics","name":"运动学","kind":"knowledge","subject":"physics","aliases":[],"include":[],"exclude":[],"status":"active"}]}$artifact$);

select lives_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    1,
    encode(extensions.digest(convert_to((select artifact_text from registry_revision_fixture), 'UTF8'), 'sha256'), 'hex'),
    (select artifact_text from registry_revision_fixture)
  )$$,
  'exact Registry revision sync succeeds'
);
select is(
  (
    select count(*)::integer
    from public.knowledge_registry_revisions
    where source_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  1,
  'Registry sync records one append-only revision'
);
select is(
  (select r.source_sha from public.knowledge_registry_state s join public.knowledge_registry_revisions r on r.id = s.active_revision_id where s.singleton),
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Registry state points at the exact source revision'
);
select is(
  (select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    1,
    encode(extensions.digest(convert_to((select artifact_text from registry_revision_fixture), 'UTF8'), 'sha256'), 'hex'),
    (select artifact_text from registry_revision_fixture)
  ) ->> 'replayed'),
  'true',
  'same source SHA and hash replay the prior success'
);
select lives_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    1,
    encode(extensions.digest(convert_to((select artifact_text from registry_revision_fixture), 'UTF8'), 'sha256'), 'hex'),
    (select artifact_text from registry_revision_fixture)
  )$$,
  'new source SHA with identical content records a no-op revision'
);
select is(
  (select applied from public.knowledge_registry_revisions where source_sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  false,
  'identical content revision is marked as not applied'
);
select throws_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    1,
    encode(extensions.digest(convert_to(replace((select artifact_text from registry_revision_fixture), '"函数"', '"函数知识"'), 'UTF8'), 'sha256'), 'hex'),
    replace((select artifact_text from registry_revision_fixture), '"函数"', '"函数知识"')
  )$$,
  '22023',
  'REGISTRY_SOURCE_PROVENANCE_CONFLICT',
  'same source SHA with different content is rejected'
);
select throws_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'cccccccccccccccccccccccccccccccccccccccc',
    1,
    repeat('0', 64),
    (select artifact_text from registry_revision_fixture)
  )$$,
  '22023',
  'REGISTRY_CONTENT_HASH_MISMATCH',
  'Registry sync recomputes the exact artifact hash'
);

insert into public.problems (
  id, user_id, subject_id, title, content, assets, solution_assets,
  solution_text, status, parts, source, is_optional
) values
  (
    'c0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
    'Durable semantics source', 'Fixture content', '[]'::jsonb, '[]'::jsonb,
    '', 'needs_review', '[{"index":1,"type":"short_answer"},{"index":2,"type":"essay"}]'::jsonb,
    '{}'::jsonb, false
  ),
  (
    'c0000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002',
    'Same-subject copy', 'Fixture content', '[]'::jsonb, '[]'::jsonb,
    '', 'needs_review', '[{"index":1,"type":"short_answer"},{"index":2,"type":"essay"}]'::jsonb,
    '{}'::jsonb, false
  ),
  (
    'c0000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000005',
    'Cross-subject copy', 'Fixture content', '[]'::jsonb, '[]'::jsonb,
    '', 'needs_review', '[{"index":1,"type":"short_answer"},{"index":2,"type":"essay"}]'::jsonb,
    '{}'::jsonb, false
  );

select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'pending',
  'Problem insertion creates durable pending annotation state'
);
select is(
  (select semantic_revision from public.problems where id = 'c0000000-0000-4000-8000-000000000003'),
  1::bigint,
  'Problem semantic revision starts at one'
);
select lives_ok(
  $$select public.apply_problem_mark_annotation(
    'c0000000-0000-4000-8000-000000000003',
    1,
    (select active_revision_id from public.knowledge_registry_state where singleton),
    '[{"mark_key":"math.knowledge.function","role":"target","part_index":null},{"mark_key":"math.knowledge.function.extremum","role":"required","part_index":1},{"mark_key":"math.skill.parameter_separation","role":"required","part_index":2}]'::jsonb,
    '[]'::jsonb
  )$$,
  'validated annotation result applies atomically'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'resolved',
  'complete annotation becomes resolved'
);
select is(
  jsonb_array_length(public.get_problem_semantics('c0000000-0000-4000-8000-000000000003') -> 'targets'),
  1,
  'stable semantics read groups Target Marks'
);
select is(
  jsonb_array_length(public.get_problem_semantics('c0000000-0000-4000-8000-000000000003') -> 'required' -> 'knowledge'),
  1,
  'stable semantics read groups Required Knowledge'
);
select is(
  jsonb_array_length(public.get_problem_semantics('c0000000-0000-4000-8000-000000000003') -> 'required' -> 'skills'),
  1,
  'stable semantics read groups Required Skills'
);
select lives_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'dddddddddddddddddddddddddddddddddddddddd',
    1,
    encode(extensions.digest(convert_to((select artifact_text from registry_revision_fixture), 'UTF8'), 'sha256'), 'hex'),
    (select artifact_text from registry_revision_fixture)
  )$$,
  'Registry active revision may advance without rewriting Problem semantics'
);
select is(
  (select r.source_sha from public.problem_mark_annotations a join public.knowledge_registry_revisions r on r.id = a.registry_revision_id where a.problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'resolved annotation retains its original Registry revision'
);
select is(
  jsonb_array_length(public.get_problem_semantics('c0000000-0000-4000-8000-000000000003') -> 'targets'),
  1,
  'resolved semantics remain readable after Registry revision advances'
);
select lives_ok(
  $$update public.problems set status = 'wrong' where id = 'c0000000-0000-4000-8000-000000000003'$$,
  'review-only Problem update succeeds'
);
select is(
  (select semantic_revision from public.problems where id = 'c0000000-0000-4000-8000-000000000003'),
  1::bigint,
  'review-only Problem update does not bump semantic revision'
);
select lives_ok(
  $$update public.problems set title = 'Changed semantics' where id = 'c0000000-0000-4000-8000-000000000003'$$,
  'semantic Problem edit succeeds despite derived Marks'
);
select is(
  (select semantic_revision from public.problems where id = 'c0000000-0000-4000-8000-000000000003'),
  2::bigint,
  'semantic Problem edit bumps the dedicated revision'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'pending',
  'semantic Problem edit resets durable annotation to pending'
);
select is(
  (select count(*)::integer from public.problem_marks where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  3,
  'semantic Problem edit retains prior projection rows while replacement is pending'
);
select is(
  jsonb_array_length(public.get_problem_semantics('c0000000-0000-4000-8000-000000000003') -> 'targets'),
  0,
  'stable semantics read hides retained rows from an older semantic revision'
);
select lives_ok(
  $$select public.apply_problem_mark_annotation(
    'c0000000-0000-4000-8000-000000000003',
    2,
    (select active_revision_id from public.knowledge_registry_state where singleton),
    '[]'::jsonb,
    '[{"role":"target","kind":"knowledge","part_index":null,"reason":"no_registry_match"}]'::jsonb
  )$$,
  'canonical no-match result is stored without inventing a Mark'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'unresolved',
  'no-match result is distinct from an operational failure'
);
select lives_ok(
  $$select public.sync_knowledge_registry_revision(
    'https://github.com/helemazuba-boop/WQN-Knowledge-Registry',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    1,
    encode(extensions.digest(convert_to((select artifact_text from registry_revision_fixture), 'UTF8'), 'sha256'), 'hex'),
    (select artifact_text from registry_revision_fixture)
  )$$,
  'Registry update does not automatically requeue unresolved Problems'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'unresolved',
  'unresolved annotation remains stable until explicitly requeued'
);
select lives_ok(
  $$select public.requeue_problem_mark_annotation('c0000000-0000-4000-8000-000000000003')$$,
  'unresolved annotation can be explicitly requeued'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000003'),
  'pending',
  'explicit requeue returns annotation to pending'
);

create temporary table mark_claim_fixture as
select public.claim_problem_mark_annotation(
  'c0000000-0000-4000-8000-000000000003',
  120
) as payload;
select is(
  (select payload ->> 'problem_id' from mark_claim_fixture),
  'c0000000-0000-4000-8000-000000000003',
  'targeted annotation claim acquires the pending head'
);
select is(
  public.claim_problem_mark_annotation(
    'c0000000-0000-4000-8000-000000000003',
    120
  ),
  null::jsonb,
  'a live annotation lease prevents a second claim'
);

create temporary table prepared_mark_run as
select public.prepare_problem_mark_annotation(
  'c0000000-0000-4000-8000-000000000003',
  2,
  (payload ->> 'lease_token')::uuid
) as payload
from mark_claim_fixture;
select is(
  (select payload ->> 'annotation_status' from prepared_mark_run),
  'pending',
  'prepare returns the current objective annotation context'
);
select is(
  (
    select status
    from public.problem_mark_annotation_runs
    where id = (
      select (payload ->> 'run_id')::uuid from prepared_mark_run
    )
  ),
  'processing',
  'prepare creates one processing annotation run'
);

select is(
  public.commit_problem_mark_annotation_run(
    (select (payload ->> 'run_id')::uuid from prepared_mark_run),
    (select (payload ->> 'lease_token')::uuid from prepared_mark_run),
    repeat('1', 64),
    repeat('2', 64),
    'checkpoint-a-compatibility',
    'skill-query-v1',
    'subject-candidates-v0',
    'fixture-model',
    'problem-marking-v1',
    'selected',
    '["math.skill.parameter_separation"]'::jsonb,
    '[{"mark_key":"math.knowledge.function","role":"target","part_index":null},{"mark_key":"math.knowledge.function.extremum","role":"required","part_index":1},{"mark_key":"math.skill.parameter_separation","role":"required","part_index":2}]'::jsonb,
    '[]'::jsonb,
    '{"skill":[{"stable_key":"math.skill.parameter_separation","rank":1,"score":1.0}]}'::jsonb
  ) ->> 'status',
  'resolved',
  'lease-bound commit atomically promotes a validated run'
);
select is(
  (
    select active_run_id::text
    from public.problem_mark_annotations
    where problem_id = 'c0000000-0000-4000-8000-000000000003'
  ),
  (select payload ->> 'run_id' from prepared_mark_run),
  'annotation head points at the committed run'
);
select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000003'
      and semantic_revision = 2
  ),
  3,
  'committed run replaces the active Problem Mark projection'
);
select throws_ok(
  $$select public.commit_problem_mark_annotation_run(
    (select (payload ->> 'run_id')::uuid from prepared_mark_run),
    (select (payload ->> 'lease_token')::uuid from prepared_mark_run),
    repeat('1', 64), repeat('2', 64),
    'checkpoint-a-compatibility', 'skill-query-v1',
    'subject-candidates-v0', 'fixture-model', 'problem-marking-v1',
    'selected', '["math.skill.parameter_separation"]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
  )$$,
  '40001',
  'PROBLEM_MARK_RUN_STALE',
  'terminal annotation run cannot be committed twice'
);
select is(
  (
    select source
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000003'
      and mark_key = 'math.skill.parameter_separation'
  ),
  'ai',
  'committed AI Skill remains an AI-origin Problem Mark'
);

select is(
  public.inherit_problem_marks('[{"source_problem_id":"c0000000-0000-4000-8000-000000000003","destination_problem_id":"c0000000-0000-4000-8000-000000000004"},{"source_problem_id":"c0000000-0000-4000-8000-000000000003","destination_problem_id":"c0000000-0000-4000-8000-000000000005"}]'::jsonb),
  '{"inherited": 1, "pending": 1}'::jsonb,
  'Copy inheritance succeeds only for compatible Canonical Subjects'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000004'),
  'resolved',
  'same-subject Copy inherits resolved annotation state'
);
select is(
  (select count(*)::integer from public.problem_marks where problem_id = 'c0000000-0000-4000-8000-000000000004'),
  3,
  'same-subject Copy inherits exact shell and Part edges'
);
select is(
  (
    select count(*)::integer
    from public.problem_marks
    where problem_id = 'c0000000-0000-4000-8000-000000000004'
      and source = 'ai'
  ),
  3,
  'new Copy preserves the source semantic origin instead of writing source=copy'
);
select is(
  (
    select copied_from_problem_id::text
    from public.problem_mark_annotation_runs
    where id = (
      select active_run_id
      from public.problem_mark_annotations
      where problem_id = 'c0000000-0000-4000-8000-000000000004'
    )
  ),
  'c0000000-0000-4000-8000-000000000003',
  'Copy provenance is recorded on the annotation run'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000005'),
  'pending',
  'cross-subject Copy remains pending instead of writing illegal edges'
);
select is(
  public.inherit_problem_marks('[{"source_problem_id":"ffffffff-ffff-4fff-8fff-ffffffffffff","destination_problem_id":"c0000000-0000-4000-8000-000000000004"}]'::jsonb),
  '{"inherited": 0, "pending": 1}'::jsonb,
  'inheritance failure is contained as pending instead of aborting Copy'
);
select is(
  (select count(*)::integer from public.problems where id = 'c0000000-0000-4000-8000-000000000004'),
  1,
  'inheritance failure never deletes the copied Problem'
);
select is(
  (select status from public.problem_mark_annotations where problem_id = 'c0000000-0000-4000-8000-000000000004'),
  'pending',
  'inheritance failure leaves destination annotation pending'
);

select * from finish();
rollback;
