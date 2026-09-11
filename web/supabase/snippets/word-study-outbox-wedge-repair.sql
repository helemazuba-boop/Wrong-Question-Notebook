-- Word study outbox wedge: diagnosis and manual repair
-- ---------------------------------------------------
-- Operational snippet. NOT a migration -- nothing here runs on deploy.
-- Read section 1, then run section 2 by hand if it matches what you see.
--
-- Symptom this addresses (observed 2026-09-08):
--   * word study produces no observations at all, while note/problem sync on
--     the same device keeps working;
--   * the device log repeats
--       W wqn_api:      word-study-observation failed: status=409 code=SEQUENCE_GAP retryable=1
--       W sync_service: word outbox upload deferred: request=req_... sequence=333 code=SEQUENCE_GAP
--       W sync_service: word outbox retry scheduled: ... attempt=255 retry_after_ms=300000
--   * no word session has been created since the wedge started.
--
-- Cause: one head record whose sequence is permanently ahead of the server's
-- next_sequence. The word outbox is FIFO, so that record blocks every later
-- one. Firmware marks SEQUENCE_GAP retryable and retries it forever with no
-- cap, so the queue never drains on its own.
--
-- 20260908000000_study_observation_abandoned_gap_terminal.sql fixes this for
-- `abandoned` sessions server-side: the device then receives
-- STUDY_SESSION_NOT_ACTIVE, quarantines the head, and the backlog drains.
-- Section 2 below is only needed when the wedged session is still `active`,
-- which the migration deliberately does not touch.

-- =====================================================================
-- 1. Diagnosis (read-only)
-- =====================================================================

-- 1a. Every word session, most recent first. The wedged one is the session the
--     device keeps sending to: its next_sequence is lower than the sequence in
--     the device log (333 in the incident above).
select s.id,
       s.mode,
       s.status,
       s.next_sequence,
       s.candidate_count,
       s.created_at,
       s.last_activity_at,
       s.expires_at,
       d.name as device_name
from public.study_sessions s
left join public.esp32_devices d on d.id = s.device_id
where s.domain = 'word'
order by s.last_activity_at desc;

-- 1b. Sessions whose counter is behind the device. Replace 333 with the
--     sequence from the device log; anything returned is a wedge candidate.
select id, mode, status, next_sequence, created_at, last_activity_at
from public.study_sessions
where domain = 'word'
  and next_sequence < 333
order by last_activity_at desc;

-- 1c. Confirm the outage window: the newest word observation on record.
--     If this is days old while note observations are current, the outbox is
--     wedged rather than the user being idle.
select max(created_at) as last_word_observation,
       max(occurred_at) as last_device_reported_at
from public.study_observations o
join public.study_sessions s on s.id = o.session_id
where s.domain = 'word';

-- 1d. Backlog shape. If nearly every non-mastered row is overdue and the
--     newest due_at is days old, progress stopped at the same moment.
select status,
       count(*) as rows,
       min(due_at) as earliest_due,
       max(due_at) as latest_due,
       max(last_reviewed_at) as last_reviewed
from public.word_progress
group by status
order by rows desc;

-- =====================================================================
-- 2. Manual repair (run deliberately, not on deploy)
-- =====================================================================
-- Retires word sessions that have been idle long enough that no device can
-- still be mid-round. Once a session is `abandoned`, the 20260908 migration
-- answers its sequence gaps with STUDY_SESSION_NOT_ACTIVE and the device
-- quarantines its backlog instead of retrying forever.
--
-- Review the output of 1b before running, and narrow the predicate to the
-- specific session id if more than one row matches.

begin;

-- Dry run first: this is exactly the set the update below would touch.
select id, mode, status, next_sequence, last_activity_at
from public.study_sessions
where domain = 'word'
  and status in ('active', 'paused')
  and last_activity_at < now() - interval '7 days';

update public.study_sessions
set status = 'abandoned',
    ended_at = now(),
    updated_at = now()
where domain = 'word'
  and status in ('active', 'paused')
  and last_activity_at < now() - interval '7 days';

-- Confirm the row count before committing.
-- commit;

-- =====================================================================
-- 3. After the device drains
-- =====================================================================
-- Re-run 1c to confirm observations are flowing again, then 1d over the
-- following days: latest_due should start moving forward. The guided-random
-- cap (WORD_STUDY_DUE_NOW_SHARE) guarantees new words keep entering sessions
-- even while the backlog is large, so no reset of word_progress is needed --
-- the backlog simply drains at 60% of each session.
