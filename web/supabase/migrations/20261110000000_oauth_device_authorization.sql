-- RFC 8628 public clients: no inbound callback or client secret is required.
alter table public.oauth_clients drop constraint oauth_clients_grant_types_check;
alter table public.oauth_clients add constraint oauth_clients_grant_types_check
  check (grant_types <@ array['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']);
alter table public.oauth_clients drop constraint oauth_clients_redirect_uris_check;
alter table public.oauth_clients add constraint oauth_clients_redirect_uris_check
  check (cardinality(redirect_uris) between 1 and 20 or
    (cardinality(redirect_uris) = 0 and
      'urn:ietf:params:oauth:grant-type:device_code' = any(grant_types) and
      not ('authorization_code' = any(grant_types))));

create table public.oauth_device_authorizations (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  device_code_hash text not null unique check (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code_hash text not null unique check (user_code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references auth.users(id) on delete cascade,
  scope text not null check (scope = 'mcp:all'),
  resource text not null check (length(resource) > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
  interval_seconds integer not null default 5 check (interval_seconds >= 5),
  next_poll_at timestamptz not null default (clock_timestamp() + interval '5 seconds'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  consumed_at timestamptz,
  check (status not in ('approved', 'consumed') or user_id is not null)
);
create index oauth_device_authorizations_expiry on public.oauth_device_authorizations(expires_at);
alter table public.oauth_device_authorizations enable row level security;
revoke all on public.oauth_device_authorizations from public, anon, authenticated;
grant all on public.oauth_device_authorizations to service_role;

-- Row locking serializes polls, including interval enforcement across web
-- processes. Consuming the device code and issuing tokens commit together.
create function public.oauth_poll_device_authorization(
  p_device_code_hash text, p_client_id text, p_resource text,
  p_access_token_hash text, p_refresh_token_hash text,
  p_access_ttl_seconds integer, p_refresh_ttl_seconds integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  grant_row public.oauth_device_authorizations%rowtype;
  poll_time timestamptz := clock_timestamp();
begin
  select * into grant_row from public.oauth_device_authorizations
    where device_code_hash = p_device_code_hash and client_id = p_client_id
    for update;
  if not found then return jsonb_build_object('error', 'invalid_grant'); end if;
  if grant_row.resource <> p_resource then return jsonb_build_object('error', 'invalid_target'); end if;
  if grant_row.expires_at <= poll_time then return jsonb_build_object('error', 'expired_token'); end if;
  if grant_row.status = 'denied' then return jsonb_build_object('error', 'access_denied'); end if;
  if grant_row.status = 'consumed' then return jsonb_build_object('error', 'invalid_grant'); end if;
  if not exists (select 1 from public.oauth_clients where client_id = p_client_id
    and 'urn:ietf:params:oauth:grant-type:device_code' = any(grant_types)) then
    return jsonb_build_object('error', 'unauthorized_client');
  end if;
  if grant_row.next_poll_at > poll_time then
    update public.oauth_device_authorizations set
      interval_seconds = interval_seconds + 5,
      next_poll_at = poll_time + make_interval(secs => interval_seconds + 5)
      where id = grant_row.id;
    return jsonb_build_object('error', 'slow_down');
  end if;
  if grant_row.status = 'pending' then
    update public.oauth_device_authorizations set
      next_poll_at = poll_time + make_interval(secs => interval_seconds)
      where id = grant_row.id;
    return jsonb_build_object('error', 'authorization_pending');
  end if;
  if p_access_ttl_seconds <= 0 or p_refresh_ttl_seconds <= 0 then
    raise exception 'Invalid token lifetime';
  end if;
  insert into public.oauth_tokens(user_id, client_id, access_token_hash,
    refresh_token_hash, scope, resource, access_token_expires_at, refresh_token_expires_at)
    values (grant_row.user_id, grant_row.client_id, p_access_token_hash,
      p_refresh_token_hash, grant_row.scope, grant_row.resource,
      poll_time + make_interval(secs => p_access_ttl_seconds),
      poll_time + make_interval(secs => p_refresh_ttl_seconds));
  update public.oauth_device_authorizations set status = 'consumed', consumed_at = poll_time
    where id = grant_row.id;
  return jsonb_build_object('scope', grant_row.scope, 'user_id', grant_row.user_id);
end;
$$;
revoke all on function public.oauth_poll_device_authorization(text,text,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.oauth_poll_device_authorization(text,text,text,text,text,integer,integer) to service_role;
