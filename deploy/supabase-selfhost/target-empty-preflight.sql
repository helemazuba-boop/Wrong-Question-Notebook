\set ON_ERROR_STOP on

do $$
declare
  existing_table text;
  has_m7_history boolean := false;
begin
  foreach existing_table in array array[
    'public.user_profiles',
    'public.problems',
    'public.todos',
    'public.word_decks',
    'public.esp32_devices',
    'public.device_claims',
    'public.esp32_request_idempotency'
  ]
  loop
    if to_regclass(existing_table) is not null then
      raise exception 'greenfield target is not empty; found WQN table: %', existing_table;
    end if;
  end loop;

  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute $query$
      select exists (
        select 1
        from supabase_migrations.schema_migrations
        where version in ('20260719000000', '20260719010000')
      )
    $query$ into has_m7_history;
    if has_m7_history then
      raise exception 'greenfield target already contains M7 migration history';
    end if;
  end if;
end
$$;
