-- Backfill projection_applied on legacy study_observations.
--
-- study_observations rows written before 20260723000000 (the RPC drift repair)
-- stored a result JSON without `projection_applied`, because the deployed
-- record_study_observation_v1 predated that field. The device replays un-acked
-- observations by request_id, and the RPC replay path returns the stored result
-- verbatim, so those legacy rows fail server-side Zod validation
-- (projection_applied: expected boolean, received undefined) and can never be
-- acknowledged -- pinning them in the device outbox on a ~5 minute retry loop.
--
-- This backfill adds projection_applied=false to any legacy result missing it.
-- false is the safe default: the canonical word_progress projection already ran
-- at the original write time, and on replay this flag is informational only.
-- The statement is idempotent (guarded by the ? operator) and a no-op on
-- databases whose observations already carry the field.

update public.study_observations
set result = result || jsonb_build_object('projection_applied', false)
where not (result ? 'projection_applied');
