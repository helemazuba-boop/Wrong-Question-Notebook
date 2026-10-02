-- Durable provider protection for image extraction.
--
-- User quota is charged before the outbound provider call. A failed call can
-- refund exactly one unit, and a database-backed fixed-window limiter keeps
-- the provider RPS cap effective across all web instances.

create table public.external_provider_rate_limits (
  scope text not null,
  bucket_start timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 3600),
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, bucket_start, window_seconds)
);

create index external_provider_rate_limits_bucket_start_idx
  on public.external_provider_rate_limits (bucket_start);

alter table public.external_provider_rate_limits enable row level security;

revoke all on table public.external_provider_rate_limits
  from public, anon, authenticated;
grant select, insert, update, delete on table public.external_provider_rate_limits
  to service_role;

create or replace function public.acquire_external_provider_rate_limit(
  p_scope text,
  p_max_requests integer,
  p_window_seconds integer default 1
)
returns json
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket_start timestamptz;
  v_current_count integer;
  v_allowed boolean := false;
  v_retry_after_ms integer;
begin
  if p_scope is null or length(btrim(p_scope)) = 0 or length(p_scope) > 128 then
    raise exception 'invalid provider rate-limit scope';
  end if;
  if p_max_requests < 1 or p_max_requests > 10000 then
    raise exception 'invalid provider rate-limit maximum';
  end if;
  if p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'invalid provider rate-limit window';
  end if;

  v_bucket_start := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );

  insert into public.external_provider_rate_limits (
    scope,
    bucket_start,
    window_seconds,
    request_count
  )
  values (p_scope, v_bucket_start, p_window_seconds, 1)
  on conflict (scope, bucket_start, window_seconds)
  do update
    set request_count = public.external_provider_rate_limits.request_count + 1,
        updated_at = v_now
    where public.external_provider_rate_limits.request_count < p_max_requests
  returning request_count into v_current_count;

  if found then
    v_allowed := true;
  else
    select request_count
      into v_current_count
      from public.external_provider_rate_limits
     where scope = p_scope
       and bucket_start = v_bucket_start
       and window_seconds = p_window_seconds;
  end if;

  v_retry_after_ms := greatest(
    ceil(
      extract(
        epoch from (
          v_bucket_start + make_interval(secs => p_window_seconds) - v_now
        )
      ) * 1000
    )::integer,
    1
  );

  -- The scope is the leading primary-key column, so this remains bounded and
  -- prevents one row per fixed window from accumulating indefinitely.
  delete from public.external_provider_rate_limits
   where scope = p_scope
     and bucket_start < v_now - interval '1 day';

  return json_build_object(
    'allowed', v_allowed,
    'current_count', coalesce(v_current_count, p_max_requests),
    'limit', p_max_requests,
    'retry_after_ms', v_retry_after_ms
  );
end;
$function$;

revoke execute on function public.acquire_external_provider_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_external_provider_rate_limit(text, integer, integer)
  to service_role;

create or replace function public.refund_quota_usage(
  p_user_id uuid,
  p_resource_type text,
  p_user_tz text default 'UTC'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_current_usage integer;
  v_today date;
begin
  v_today := public.user_today(p_user_tz);

  update public.usage_quotas
     set usage_count = usage_count - 1,
         updated_at = now()
   where user_id = p_user_id
     and resource_type = p_resource_type
     and period_start = v_today
     and usage_count > 0
  returning usage_count into v_current_usage;

  return coalesce(v_current_usage, 0);
end;
$function$;

revoke execute on function public.refund_quota_usage(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.refund_quota_usage(uuid, text, text)
  to service_role;

-- Replace a Problem's tag links as one transaction. The old route performed a
-- DELETE followed by an unchecked INSERT, which could silently erase all tags.
create or replace function public.replace_problem_tags(
  p_problem_id uuid,
  p_tag_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_subject_id uuid;
  v_distinct_count integer;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select subject_id
    into v_subject_id
    from public.problems
   where id = p_problem_id
     and user_id = v_user_id
   for update;
  if not found then
    raise exception 'Problem not found' using errcode = 'P0002';
  end if;

  select count(distinct value)
    into v_distinct_count
    from unnest(coalesce(p_tag_ids, array[]::uuid[])) as requested(value);
  if v_distinct_count > 100 then
    raise exception 'too many tags';
  end if;
  if v_distinct_count <> cardinality(coalesce(p_tag_ids, array[]::uuid[])) then
    raise exception 'tag IDs must be unique';
  end if;
  if exists (
    select 1
      from unnest(coalesce(p_tag_ids, array[]::uuid[])) as requested(value)
      left join public.tags tag
        on tag.id = requested.value
       and tag.user_id = v_user_id
       and tag.subject_id = v_subject_id
     where tag.id is null
  ) then
    raise exception 'tag does not belong to the Problem subject';
  end if;

  delete from public.problem_tag
   where problem_id = p_problem_id
     and user_id = v_user_id;

  insert into public.problem_tag (problem_id, tag_id, user_id)
  select p_problem_id, requested.value, v_user_id
    from unnest(coalesce(p_tag_ids, array[]::uuid[])) as requested(value);
end;
$function$;

revoke execute on function public.replace_problem_tags(uuid, uuid[])
  from public, anon;
grant execute on function public.replace_problem_tags(uuid, uuid[])
  to authenticated, service_role;
