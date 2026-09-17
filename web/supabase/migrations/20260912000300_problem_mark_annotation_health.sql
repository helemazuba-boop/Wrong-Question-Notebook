-- Problem Mark annotation: queue health
--
-- The queue had no read model at all: nothing surfaced how many annotations
-- were stuck, how old the oldest one was, or which error codes were winning.
-- Failures were only visible by querying the table directly.
--
-- This is the single read the admin surface uses. It is deliberately a SQL
-- function rather than row fetching in the route: the aggregate stays in the
-- database and the route never pulls the whole table.

create or replace function public.problem_mark_annotation_health()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'status_counts', coalesce((
      select jsonb_agg(entry order by (entry ->> 'total')::integer desc)
      from (
        select jsonb_build_object(
          'status', status, 'total', count(*)::integer
        ) as entry
        from public.problem_mark_annotations
        group by status
      ) grouped
    ), '[]'::jsonb),
    'error_counts', coalesce((
      select jsonb_agg(entry order by (entry ->> 'total')::integer desc)
      from (
        select jsonb_build_object(
          'last_error_code', last_error_code,
          'total', count(*)::integer
        ) as entry
        from public.problem_mark_annotations
        where last_error_code is not null
        group by last_error_code
      ) grouped
    ), '[]'::jsonb),
    'oldest_pending_age_seconds', (
      select coalesce(
        extract(epoch from (clock_timestamp() - min(next_retry_at)))::bigint,
        0
      )
      from public.problem_mark_annotations
      where status in ('pending', 'failed')
    ),
    'stuck_total', (
      select count(*)::integer
      from public.problem_mark_annotations
      where status = 'abandoned'
         or attempt_count >= 8
    ),
    'recent_failures', coalesce((
      select jsonb_agg(
        entry order by (entry ->> 'updated_at')::timestamptz desc
      )
      from (
        select jsonb_build_object(
          'problem_id', problem_id,
          'status', status,
          'last_error_code', last_error_code,
          'attempt_count', attempt_count,
          'updated_at', updated_at
        ) as entry
        from public.problem_mark_annotations
        where status in ('failed', 'abandoned')
        order by updated_at desc
        limit 20
      ) grouped
    ), '[]'::jsonb),
    'enqueue_errors', coalesce((
      select jsonb_agg(
        entry order by (entry ->> 'occurred_at')::timestamptz desc
      )
      from (
        select jsonb_build_object(
          'problem_id', problem_id,
          'error_text', error_text,
          'occurred_at', occurred_at
        ) as entry
        from public.problem_mark_enqueue_errors
        order by occurred_at desc
        limit 20
      ) grouped
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.problem_mark_annotation_health()
  from public, anon, authenticated;
grant execute on function public.problem_mark_annotation_health()
  to service_role;
