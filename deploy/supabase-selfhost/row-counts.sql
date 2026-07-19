select 'auth.users' as relation, count(*) as rows from auth.users
union all select 'public.user_profiles', count(*) from public.user_profiles
union all select 'public.problems', count(*) from public.problems
union all select 'public.todos', count(*) from public.todos
union all select 'public.esp32_devices', count(*) from public.esp32_devices
union all select 'public.device_claims', count(*) from public.device_claims
union all select 'public.esp32_request_idempotency', count(*) from public.esp32_request_idempotency
union all select 'storage.buckets', count(*) from storage.buckets
union all select 'storage.objects', count(*) from storage.objects
order by relation;
