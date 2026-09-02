\set ON_ERROR_STOP on

-- These relations are intentionally outside the production-data replacement
-- set. Compare this output byte-for-byte before and after the rehearsal.
select relation, rows, digest
from (
  select 'auth.schema_migrations' as relation,
         count(*)::bigint as rows,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), '')) as digest
  from auth.schema_migrations row_value

  union all
  select 'storage.migrations', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.migrations row_value

  union all
  select 'supabase_migrations.schema_migrations', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from supabase_migrations.schema_migrations row_value

  union all
  select 'storage.buckets_analytics', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.buckets_analytics row_value

  union all
  select 'storage.buckets_vectors', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.buckets_vectors row_value

  union all
  select 'storage.vector_indexes', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.vector_indexes row_value

  union all
  select 'storage.iceberg_namespaces', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.iceberg_namespaces row_value

  union all
  select 'storage.iceberg_tables', count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))
  from storage.iceberg_tables row_value
) fingerprint
order by relation;
