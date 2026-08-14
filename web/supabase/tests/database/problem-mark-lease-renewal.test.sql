begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Fixtures. The annotation head is seeded holding a live lease (token A); the
-- renewal RPC rotates that token on every successful renewal, which is what
-- makes the lease a generation tag.
insert into auth.users (id, email)
values ('11000000-0000-4000-8000-0000000000aa', 'renewal-fixture@example.com');

insert into public.subjects (id, user_id, name)
values (
  '22000000-0000-4000-8000-0000000000aa',
  '11000000-0000-4000-8000-0000000000aa',
  'Renewal fixture'
);

insert into public.problems (id, user_id, subject_id, title, status, parts)
values (
  '33000000-0000-4000-8000-0000000000aa',
  '11000000-0000-4000-8000-0000000000aa',
  '22000000-0000-4000-8000-0000000000aa',
  'Renewal fixture problem',
  'needs_review',
  '[{"index":1,"type":"essay"}]'::jsonb
);

-- The enqueue trigger has already created the annotation head on the Problem
-- insert; claim it by setting a live lease (token A). The renewal RPC rotates
-- that token on every successful renewal, which is what makes the lease a
-- generation tag.
update public.problem_mark_annotations
set lease_token = '44000000-0000-4000-8000-0000000000aa',
    lease_until = clock_timestamp() + interval '60 seconds'
where problem_id = '33000000-0000-4000-8000-0000000000aa';

select has_function(
  'public',
  'renew_problem_mark_annotation_lease',
  array['uuid', 'uuid', 'integer'],
  'lease renewal RPC exists'
);

select lives_ok(
  $$
    select public.renew_problem_mark_annotation_lease(
      '33000000-0000-4000-8000-0000000000aa',
      '44000000-0000-4000-8000-0000000000aa',
      300
    )
  $$,
  'renewal with the live lease token succeeds'
);

select isnt(
  (
    select lease_token::text
    from public.problem_mark_annotations
    where problem_id = '33000000-0000-4000-8000-0000000000aa'
  ),
  '44000000-0000-4000-8000-0000000000aa',
  'renewal rotates the lease token (generation tag)'
);

select ok(
  (
    select lease_until > clock_timestamp() + interval '200 seconds'
    from public.problem_mark_annotations
    where problem_id = '33000000-0000-4000-8000-0000000000aa'
  ),
  'renewal extends the lease deadline'
);

-- The rotated-away token A can no longer renew: a stale/competing worker
-- holding it is rejected, so it can never reach commit.
select throws_ok(
  $$
    select public.renew_problem_mark_annotation_lease(
      '33000000-0000-4000-8000-0000000000aa',
      '44000000-0000-4000-8000-0000000000aa',
      300
    )
  $$,
  '40001',
  'PROBLEM_MARK_LEASE_STALE',
  'a rotated-away lease token is rejected as stale'
);

select throws_ok(
  $$
    select public.renew_problem_mark_annotation_lease(
      '33000000-0000-4000-8000-0000000000aa',
      (
        select lease_token
        from public.problem_mark_annotations
        where problem_id = '33000000-0000-4000-8000-0000000000aa'
      ),
      10
    )
  $$,
  '22023',
  'INVALID_PROBLEM_MARK_LEASE_RENEWAL',
  'an out-of-range lease duration is rejected'
);

-- An expired lease cannot be renewed even with the current token.
update public.problem_mark_annotations
set lease_until = clock_timestamp() - interval '1 second'
where problem_id = '33000000-0000-4000-8000-0000000000aa';

select throws_ok(
  $$
    select public.renew_problem_mark_annotation_lease(
      '33000000-0000-4000-8000-0000000000aa',
      (
        select lease_token
        from public.problem_mark_annotations
        where problem_id = '33000000-0000-4000-8000-0000000000aa'
      ),
      300
    )
  $$,
  '40001',
  'PROBLEM_MARK_LEASE_STALE',
  'an expired lease cannot be renewed'
);

-- A finished/reclaimed annotation (lease cleared) cannot be renewed.
update public.problem_mark_annotations
set lease_token = null,
    lease_until = null
where problem_id = '33000000-0000-4000-8000-0000000000aa';

select throws_ok(
  $$
    select public.renew_problem_mark_annotation_lease(
      '33000000-0000-4000-8000-0000000000aa',
      '44000000-0000-4000-8000-0000000000aa',
      300
    )
  $$,
  '40001',
  'PROBLEM_MARK_LEASE_STALE',
  'a cleared lease cannot be renewed'
);

delete from public.problems
where id = '33000000-0000-4000-8000-0000000000aa';
delete from public.subjects
where id = '22000000-0000-4000-8000-0000000000aa';
delete from auth.users
where id = '11000000-0000-4000-8000-0000000000aa';

select * from finish();

rollback;
