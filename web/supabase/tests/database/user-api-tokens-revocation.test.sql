begin;

create extension if not exists pgtap with schema extensions;

select plan(3);

-- Token revocation is soft (revoked_at) so the audit trail
-- (name/created_at/last_used_at) survives. A hard DELETE grant/policy would
-- let any authenticated client erase that history through the Data API.
select is_empty(
  $$
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_api_tokens'
      and cmd = 'DELETE'
  $$,
  'no DELETE policy on user_api_tokens'
);

select is_empty(
  $$
    select grantee.rolname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) acl
    join pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and c.relname = 'user_api_tokens'
      and grantee.rolname = 'authenticated'
      and acl.privilege_type = 'DELETE'
  $$,
  'authenticated holds no DELETE grant on user_api_tokens'
);

-- The soft-revocation path must survive: owners keep an UPDATE policy (the
-- column-level grant limits them to revoked_at).
select isnt_empty(
  $$
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_api_tokens'
      and cmd = 'UPDATE'
  $$,
  'owner UPDATE policy for soft revocation is still in place'
);

select * from finish();

rollback;
