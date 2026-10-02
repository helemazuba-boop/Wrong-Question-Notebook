\set ON_ERROR_STOP on

-- Run after data.sql in the same transaction. The dump begins with
-- session_replication_role=replica so self-referential foreign keys can load;
-- checks below run after restoring normal trigger behavior.
set session_replication_role = origin;

do $$
declare
  foreign_key record;
  join_condition text;
  all_key_columns_nonnull text;
  all_key_columns_null text;
  violation_condition text;
  violation_count bigint;
begin
  for foreign_key in
    select constraint_row.oid,
           constraint_row.conname,
           constraint_row.conkey,
           constraint_row.confkey,
           constraint_row.confmatchtype,
           source_namespace.nspname as source_schema,
           source_table.relname as source_table,
           target_namespace.nspname as target_schema,
           target_table.relname as target_table
    from pg_constraint constraint_row
    join pg_class source_table on source_table.oid = constraint_row.conrelid
    join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace
    join pg_class target_table on target_table.oid = constraint_row.confrelid
    join pg_namespace target_namespace on target_namespace.oid = target_table.relnamespace
    where constraint_row.contype = 'f'
      and source_namespace.nspname in ('auth', 'public', 'storage')
    order by source_namespace.nspname, source_table.relname, constraint_row.conname
  loop
    select string_agg(format('source_row.%I = target_row.%I', source_column.attname, target_column.attname),
                      ' and ' order by key_column.ordinality),
           string_agg(format('source_row.%I is not null', source_column.attname),
                      ' and ' order by key_column.ordinality),
           string_agg(format('source_row.%I is null', source_column.attname),
                      ' and ' order by key_column.ordinality)
      into join_condition, all_key_columns_nonnull, all_key_columns_null
    from unnest(foreign_key.conkey, foreign_key.confkey)
         with ordinality as key_column(source_attnum, target_attnum, ordinality)
    join pg_attribute source_column
      on source_column.attrelid = format('%I.%I', foreign_key.source_schema, foreign_key.source_table)::regclass
     and source_column.attnum = key_column.source_attnum
    join pg_attribute target_column
      on target_column.attrelid = format('%I.%I', foreign_key.target_schema, foreign_key.target_table)::regclass
     and target_column.attnum = key_column.target_attnum;

    if foreign_key.confmatchtype = 'f' then
      violation_condition := format('not (%s) and target_row.tableoid is null', all_key_columns_null);
    else
      violation_condition := format('(%s) and target_row.tableoid is null', all_key_columns_nonnull);
    end if;

    execute format(
      'select count(*) from %I.%I source_row left join %I.%I target_row on %s where %s',
      foreign_key.source_schema,
      foreign_key.source_table,
      foreign_key.target_schema,
      foreign_key.target_table,
      join_condition,
      violation_condition
    ) into violation_count;

    if violation_count <> 0 then
      raise exception 'foreign-key integrity failure: %.% constraint % has % orphan row(s)',
        foreign_key.source_schema,
        foreign_key.source_table,
        foreign_key.conname,
        violation_count;
    end if;
  end loop;
end
$$;

do $$
begin
  if exists (
    select 1
    from auth.identities identity_row
    left join auth.users user_row on user_row.id = identity_row.user_id
    where user_row.id is null
  ) then
    raise exception 'auth.identities contains an orphan user_id';
  end if;

  if exists (
    select 1
    from public.user_profiles profile_row
    left join auth.users user_row on user_row.id = profile_row.id
    where user_row.id is null
  ) then
    raise exception 'public.user_profiles contains an orphan Auth user';
  end if;

  if exists (
    select 1
    from storage.objects object_row
    left join storage.buckets bucket_row on bucket_row.id = object_row.bucket_id
    where bucket_row.id is null
  ) then
    raise exception 'storage.objects contains an orphan bucket_id';
  end if;

  if exists (
    select 1
    from storage.objects object_row
    left join auth.users user_row on user_row.id::text = object_row.owner_id
    where object_row.owner_id is not null
      and user_row.id is null
  ) then
    raise exception 'storage.objects contains an owner_id absent from auth.users';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'esp32_devices'
      and column_name = 'access_token'
  ) then
    raise exception 'plaintext public.esp32_devices.access_token still exists';
  end if;

  if exists (
    select 1
    from public.esp32_devices
    where access_token_hash is null
       or access_token_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid public.esp32_devices.access_token_hash found';
  end if;
end
$$;

select 'auth.users' as relation, count(*)::bigint as rows from auth.users
union all select 'auth.identities', count(*) from auth.identities
union all select 'public.user_profiles', count(*) from public.user_profiles
union all select 'public.problems', count(*) from public.problems
union all select 'public.notebook_notes', count(*) from public.notebook_notes
union all select 'public.study_observations', count(*) from public.study_observations
union all select 'public.word_entries', count(*) from public.word_entries
union all select 'public.word_progress', count(*) from public.word_progress
union all select 'public.word_review_events', count(*) from public.word_review_events
union all select 'storage.buckets', count(*) from storage.buckets
union all select 'storage.objects', count(*) from storage.objects
order by relation;

select bucket_id, count(*)::bigint as metadata_objects
from storage.objects
group by bucket_id
order by bucket_id;
