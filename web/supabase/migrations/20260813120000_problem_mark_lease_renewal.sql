-- Generation-tagged lease renewal for Problem Mark annotation runs.
--
-- The annotation pipeline performs two slow external calls per run (the
-- embedding provider query and the objective-marking LLM call). A single
-- fixed 120s claim lease cannot cover the worst case, so a worker renews the
-- lease between those steps. Each renewal ROTATES lease_token: the previous
-- token is invalidated, which makes the renewal a generation tag -- a stale or
-- competing worker holding an older token can no longer commit, because commit
-- validates the live head lease_token. Renewal of an expired/reclaimed/finished
-- annotation matches no row and raises PROBLEM_MARK_LEASE_STALE, telling the
-- caller to stop immediately.

create or replace function public.renew_problem_mark_annotation_lease(
  p_problem_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease_token uuid;
  v_lease_until timestamptz;
begin
  if p_problem_id is null
     or p_lease_token is null
     or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'INVALID_PROBLEM_MARK_LEASE_RENEWAL';
  end if;

  update public.problem_mark_annotations annotation
  set lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  where annotation.problem_id = p_problem_id
    and annotation.lease_token = p_lease_token
    and annotation.lease_until > clock_timestamp()
  returning annotation.lease_token, annotation.lease_until
  into v_lease_token, v_lease_until;

  if not found then
    raise exception using errcode = '40001', message = 'PROBLEM_MARK_LEASE_STALE';
  end if;

  return jsonb_build_object(
    'lease_token', v_lease_token,
    'lease_until', v_lease_until
  );
end;
$$;

revoke all on function public.renew_problem_mark_annotation_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_problem_mark_annotation_lease(uuid, uuid, integer)
  to service_role;
