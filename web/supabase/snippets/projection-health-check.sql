-- Review projection health check
-- ------------------------------
-- Operational snippet. NOT a migration -- nothing here runs on deploy.
--
-- Why this exists (2026-09 incident): record_problem_review_v1 stopped writing
-- review_schedule directly and handed that job to the asynchronous projector,
-- but nothing ever triggered the projector in the self-hosted deployment.
-- vercel.json crons never fire on the ECS container, no pg_cron job was
-- scheduled, and the App container has no in-process timer, so every review
-- from 2026-08 onward was recorded as a fact and never projected: due dates
-- froze for weeks and nothing surfaced an error.
--
-- The word scheduler added in 20260921000000_word_progress_scheduler_authority
-- uses the same shape, so both halves are checked here. Problem rows and word
-- rows share the columns below; entity_id is the problem id for problem rows
-- and the word entry id for word rows.
--
-- Section 1 is the one-screen overview. Section 2 returns rows ONLY when
-- something is wrong -- an empty result means the projector is keeping up.
--
-- Run section 1/2 in the SQL editor, or from the ECS host as:
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     -f /path/to/projection-health-check.sql
--
-- The cron entry that drives the projector must also be watched. Its log line
-- carries the batch counters, so a dead cron looks like this:
--   grep -c '"failed":[1-9]' /var/log/wqn-cron.log
-- and a cron that stopped firing looks like an empty tail:
--   tail -5 /var/log/wqn-cron.log

-- ---------------------------------------------------------------------------
-- Section 1: overview
-- ---------------------------------------------------------------------------

select 'projection_jobs' as table_name, status, count(*) as rows
from public.problem_review_projection_jobs
group by status
union all
select 'projection_runs', status, count(*)
from public.problem_review_projection_runs
group by status
union all
select 'fsrs_projection', case when card_initialized then 'initialized' else 'empty' end, count(*)
from public.fsrs_review_schedule_projection
group by 2
union all
select 'review_schedule', authority_algorithm, count(*)
from public.review_schedule
group by authority_algorithm
union all
select 'word_projection_jobs', status, count(*)
from public.word_progress_projection_jobs
group by status
union all
select 'word_projection_runs', status, count(*)
from public.word_progress_projection_runs
group by status
union all
select 'word_fsrs_projection', case when card_initialized then 'initialized' else 'empty' end, count(*)
from public.word_progress_fsrs_projection
group by 2
union all
select 'word_progress', authority_algorithm, count(*)
from public.word_progress
group by authority_algorithm
union all
select 'word_scheduler_settings', authority_mode, count(*)
from public.user_word_scheduler_settings
group by authority_mode
order by table_name, status;

-- ---------------------------------------------------------------------------
-- Section 2: anomalies (empty result == healthy)
-- ---------------------------------------------------------------------------

with overdue_jobs as (
  select
    'overdue_retry' as check_name,
    'high' as severity,
    job.user_id,
    job.problem_id as entity_id,
    format(
      'job has been retryable since %s (status=%s, attempts=%s, last_error=%s); the projector is not draining it',
      job.next_retry_at, job.status, job.attempt_count, coalesce(job.last_error_code, 'none')
    ) as detail
  from public.problem_review_projection_jobs job
  where job.next_retry_at <= now() - interval '30 minutes'
),
expired_leases as (
  select
    'expired_lease',
    'high',
    job.user_id,
    job.problem_id,
    format(
      'lease %s expired at %s and was never reclaimed; the projector stopped mid-run',
      job.lease_token, job.lease_until
    )
  from public.problem_review_projection_jobs job
  where job.status = 'processing'
    and job.lease_until <= now() - interval '10 minutes'
),
orphan_runs as (
  select
    'orphan_run',
    'medium',
    run.user_id,
    run.problem_id,
    format(
      'run %s has been processing since %s (no completed_at)',
      run.id, run.started_at
    )
  from public.problem_review_projection_runs run
  where run.status = 'processing'
    and run.started_at <= now() - interval '30 minutes'
),
unprojected_timeline as (
  select
    'unprojected_timeline',
    'high',
    event.user_id,
    event.problem_id,
    format(
      '%s review event(s) exist but no FSRS projection row was ever committed',
      count(*)
    )
  from public.effective_problem_review_events event
  left join public.fsrs_review_schedule_projection projection
    on projection.user_id = event.user_id
   and projection.problem_id = event.problem_id
  where event.event_kind = 'review'
    and projection.user_id is null
  group by event.user_id, event.problem_id
),
schedule_behind_timeline as (
  select
    'schedule_behind_timeline',
    'high',
    event.user_id,
    event.problem_id,
    format(
      'newest review is %s but review_schedule.last_reviewed_at is %s: reviews are recorded and the schedule never advanced',
      max(event.effective_review_at),
      coalesce(schedule.last_reviewed_at::text, 'null')
    )
  from public.effective_problem_review_events event
  join public.review_schedule schedule
    on schedule.user_id = event.user_id
   and schedule.problem_id = event.problem_id
  where event.event_kind = 'review'
  group by event.user_id, event.problem_id, schedule.last_reviewed_at
  having max(event.effective_review_at) > coalesce(schedule.last_reviewed_at, '-infinity'::timestamptz)
),
word_overdue_jobs as (
  select
    'word_overdue_retry',
    'high',
    job.user_id,
    job.word_entry_id,
    format(
      'job has been retryable since %s (status=%s, attempts=%s, last_error=%s); the projector is not draining it',
      job.next_retry_at, job.status, job.attempt_count, coalesce(job.last_error_code, 'none')
    )
  from public.word_progress_projection_jobs job
  where job.next_retry_at <= now() - interval '30 minutes'
),
word_expired_leases as (
  select
    'word_expired_lease',
    'high',
    job.user_id,
    job.word_entry_id,
    format(
      'lease %s expired at %s and was never reclaimed; the projector stopped mid-run',
      job.lease_token, job.lease_until
    )
  from public.word_progress_projection_jobs job
  where job.status = 'processing'
    and job.lease_until <= now() - interval '10 minutes'
),
word_orphan_runs as (
  select
    'word_orphan_run',
    'medium',
    run.user_id,
    run.word_entry_id,
    format(
      'run %s has been processing since %s (no completed_at)',
      run.id, run.started_at
    )
  from public.word_progress_projection_runs run
  where run.status = 'processing'
    and run.started_at <= now() - interval '30 minutes'
),
-- A job that exhausted its attempts is no longer claimable (next_retry_at =
-- 'infinity'), so nothing will ever drain it on its own.
word_abandoned_jobs as (
  select
    'word_abandoned_retry',
    'high',
    job.user_id,
    job.word_entry_id,
    format(
      'job stopped retrying after %s attempt(s) (last_error=%s); under fsrs authority this word keeps the due date it had before the failure',
      job.attempt_count, coalesce(job.last_error_code, 'none')
    )
  from public.word_progress_projection_jobs job
  where job.next_retry_at = 'infinity'::timestamptz
),
word_unprojected_timeline as (
  select
    'word_unprojected_timeline',
    'high',
    event.user_id,
    event.word_entry_id,
    format(
      '%s known/unknown event(s) exist but no shadow card was ever committed',
      count(*)
    )
  from public.word_review_events event
  left join public.word_progress_fsrs_projection projection
    on projection.user_id = event.user_id
   and projection.word_entry_id = event.word_entry_id
  where event.outcome in ('known', 'unknown')
    and coalesce(projection.card_initialized, false) = false
  group by event.user_id, event.word_entry_id
),
word_authority_behind as (
  select
    'word_authority_behind',
    'high',
    progress.user_id,
    progress.word_entry_id,
    format(
      'user is on fsrs but word_progress carries revision %s while the shadow is at %s: the newest timeline never reached the schedule',
      coalesce(progress.authority_projection_revision::text, 'null'),
      projection.projection_revision
    )
  from public.word_progress progress
  join public.user_word_scheduler_settings settings
    on settings.user_id = progress.user_id
   and settings.authority_mode = 'fsrs'
  join public.word_progress_fsrs_projection projection
    on projection.user_id = progress.user_id
   and projection.word_entry_id = progress.word_entry_id
   and projection.card_initialized
  where progress.authority_projection_revision is distinct from projection.projection_revision
)
select * from overdue_jobs
union all select * from expired_leases
union all select * from orphan_runs
union all select * from unprojected_timeline
union all select * from schedule_behind_timeline
union all select * from word_overdue_jobs
union all select * from word_expired_leases
union all select * from word_orphan_runs
union all select * from word_abandoned_jobs
union all select * from word_unprojected_timeline
union all select * from word_authority_behind
order by severity, check_name, user_id, entity_id;

-- ---------------------------------------------------------------------------
-- Section 3: what each check means, and what to do
-- ---------------------------------------------------------------------------
--
-- overdue_retry        The job queue is not moving. Check that the cron entry
--                      still exists and that /api/cron/project-problem-reviews
--                      answers 200 with a body like
--                      {"claimed":N,"committed":N,"stale":0,"failed":0,
--                       "words":{...},"seed":{"inserted":N,"authority_mode":...}}.
--                      A 401 means CRON_SECRET is missing from the container
--                      environment; the deployment scripts now refuse to
--                      release without it.
-- expired_lease        A batch died between claim and commit. The next claim
--                      reclaims it (claim_problem_review_projection_jobs takes
--                      over processing rows whose lease_until has passed), so
--                      a persistent row here again means the cron is not
--                      running at all.
-- orphan_run           Same root cause as expired_lease, seen on the run row
--                      instead of the job row.
-- unprojected_timeline This is the 2026-09 failure mode. Facts exist, the
--                      shadow projection does not. Nothing is lost: the
--                      projector replays the whole timeline on the next run.
-- schedule_behind_timeline
--                      The projection may exist but the authoritative
--                      review_schedule is stale, so the device keeps seeing an
--                      old due date. Same fix: run the projector.
--
-- The word_* rows mean the same things on word_progress:
--
-- word_overdue_retry / word_expired_lease / word_orphan_run
--                      The word half of the same cron drain
--                      (runWordProjectionBatch) is not keeping up. The word
--                      queue shares the cron entry, so if the problem rows are
--                      clean and these are not, look at the "words" object in
--                      the cron response for the failure.
-- word_unprojected_timeline
--                      A word has known/unknown facts but no shadow card. The
--                      next projection run rebuilds it; a cutover for that user
--                      is refused with FSRS_CUTOVER_PROJECTION_MISSING until it
--                      does.
-- word_abandoned_retry
--                      The job gave up after 8 attempts. Under fsrs authority
--                      the sync path no longer writes status/due_at, so this
--                      word is frozen at whatever schedule it had (a word that
--                      was never committed has due_at = null and will keep
--                      coming back in the study list). Find the cause in
--                      last_error_code, fix it, then requeue by hand:
--                        update public.word_progress_projection_jobs
--                        set status = 'pending', lease_token = null,
--                            lease_until = null, attempt_count = 0,
--                            next_retry_at = now(), last_error_code = null
--                        where user_id = '<uuid>' and word_entry_id = '<uuid>';
--                      The next recorded review for that word resets
--                      attempt_count on its own, so a word is never bricked by
--                      one bad streak.
-- word_authority_behind
--                      Only users already cut over to fsrs. The sync path only
--                      keeps counters, so a stale authority_projection_revision
--                      means word due dates are not advancing even though
--                      reviews are being recorded -- the word-side twin of the
--                      2026-09 incident.
--
-- After the projector has caught up, re-run section 2. It should return zero
-- rows before you consider a per-user FSRS cutover.
