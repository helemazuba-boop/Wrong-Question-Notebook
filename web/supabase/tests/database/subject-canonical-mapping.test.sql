begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixtures ---------------------------------------------------------------------
insert into auth.users (id, email)
values ('11000000-0000-4000-8000-0000000000bb', 'subject-mapping@example.com');

-- 1. Structure ----------------------------------------------------------------
select has_table(
  'public',
  'subject_canonical_aliases',
  'subject canonical alias table exists'
);

select has_function(
  'public',
  'resolve_canonical_subject_key',
  array['text'],
  'canonical subject resolution function exists'
);

-- 2. Resolution ---------------------------------------------------------------
select is(
  public.resolve_canonical_subject_key('物理'),
  'physics',
  'a canonical preset name resolves directly'
);

select is(
  public.resolve_canonical_subject_key('Physics'),
  'physics',
  'a declared English alias resolves'
);

select is(
  public.resolve_canonical_subject_key('高三物理'),
  'physics',
  'a grade qualifier is stripped before matching'
);

select is(
  public.resolve_canonical_subject_key('人教版必修数学'),
  'math',
  'edition and stream qualifiers are stripped'
);

select is(
  public.resolve_canonical_subject_key('物理竞赛'),
  'physics',
  'a longer custom name falls back to the contained alias'
);

select is(
  public.resolve_canonical_subject_key('信息技术'),
  'information_technology',
  'a multi-character preset name is not mangled by the qualifier strip'
);

select is(
  public.resolve_canonical_subject_key('我的摘抄本'),
  null,
  'an unrelated name resolves to null rather than guessing'
);

-- 3. Derivation on write ------------------------------------------------------
insert into public.subjects (id, user_id, name)
values (
  '22000000-0000-4000-8000-0000000000bb',
  '11000000-0000-4000-8000-0000000000bb',
  '高三物理'
);

select is(
  (select canonical_subject_key from public.subjects
    where id = '22000000-0000-4000-8000-0000000000bb'),
  'physics',
  'inserting a custom-named Subject derives its canonical key'
);

-- A rename re-derives, because the previous value was itself derived.
update public.subjects
set name = '高中数学'
where id = '22000000-0000-4000-8000-0000000000bb';

select is(
  (select canonical_subject_key from public.subjects
    where id = '22000000-0000-4000-8000-0000000000bb'),
  'math',
  'renaming a Subject re-derives its canonical key'
);

-- An explicit server-side assignment survives a rename.
update public.subjects
set name = '物理笔记',
    canonical_subject_key = 'chemistry'
where id = '22000000-0000-4000-8000-0000000000bb';

select is(
  (select canonical_subject_key from public.subjects
    where id = '22000000-0000-4000-8000-0000000000bb'),
  'chemistry',
  'an explicitly assigned canonical key survives a rename'
);

select * from finish();

rollback;
