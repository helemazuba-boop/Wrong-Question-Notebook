import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  claimProjectionJobs,
  projectClaimedTimeline,
} from '@/lib/fsrs/projector';

const localUrl = process.env.FSRS_TEST_SUPABASE_URL;
const serviceKey = process.env.FSRS_TEST_SUPABASE_SERVICE_ROLE_KEY;
const describeLocal = localUrl && serviceKey ? describe : describe.skip;

function createLocalClient() {
  if (!localUrl || !serviceKey) return null;
  return createClient<Database>(localUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const USER_ID = '11000000-0000-4000-8000-000000000091';
const SUBJECT_ID = '22000000-0000-4000-8000-000000000091';
const PROBLEM_ID = '33000000-0000-4000-8000-000000000091';
const OCCURRENCE_ID = '55000000-0000-4000-8000-000000000091';
const EVENT_ID = '44000000-0000-4000-8000-000000000091';
const SECOND_OCCURRENCE_ID = '55000000-0000-4000-8000-000000000092';
const SECOND_EVENT_ID = '44000000-0000-4000-8000-000000000092';

function assertNoError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

describeLocal('FSRS projector local database integration', () => {
  const supabase = createLocalClient();
  if (!supabase) return;

  beforeAll(async () => {
    await supabase.auth.admin.deleteUser(USER_ID);

    const { error: userError } = await supabase.auth.admin.createUser({
      id: USER_ID,
      email: 'fsrs-projector-integration@example.com',
      email_confirm: true,
    });
    assertNoError(userError);

    const { error: profileError } = await supabase
      .from('user_profiles')
      .update({ timezone: 'UTC' })
      .eq('id', USER_ID);
    assertNoError(profileError);

    const { error: subjectError } = await supabase.from('subjects').insert({
      id: SUBJECT_ID,
      user_id: USER_ID,
      name: 'FSRS projector integration',
    });
    assertNoError(subjectError);

    const { error: problemError } = await supabase.from('problems').insert({
      id: PROBLEM_ID,
      user_id: USER_ID,
      subject_id: SUBJECT_ID,
      title: 'Human Hard projects both schedulers',
      status: 'needs_review',
      parts: [{ index: 1, type: 'short_answer', content: 'Q' }],
    });
    assertNoError(problemError);

    const { error: scheduleError } = await supabase
      .from('review_schedule')
      .insert({
        user_id: USER_ID,
        problem_id: PROBLEM_ID,
        next_review_at: '2026-08-08T00:00:00.000Z',
        interval_days: 12,
        ease_factor: 2.4,
        repetition_number: 3,
        last_reviewed_at: '2026-08-07T08:00:00.000Z',
      });
    assertNoError(scheduleError);

    const { error: reviewError } = await supabase.rpc(
      'record_problem_review_fact',
      {
        p_event_id: EVENT_ID,
        p_review_occurrence_id: OCCURRENCE_ID,
        p_user_id: USER_ID,
        p_problem_id: PROBLEM_ID,
        p_attempt_id: null,
        p_event_kind: 'review',
        p_human_rating: 'Hard',
        p_machine_correctness_snapshot: false,
        p_channel_source: 'web',
        p_device_id: null,
        p_source_request_id: 'fsrs-projector-e2e-000001',
        p_reviewed_at: '2026-08-08T08:00:00.000Z',
        p_initial_idea_revision_id: null,
        p_supersedes_event_id: null,
      }
    );
    assertNoError(reviewError);
  });

  afterAll(async () => {
    await supabase.auth.admin.deleteUser(USER_ID);
  });

  it('commits FSRS shadow and transitional SM-2 authority from one Hard Event', async () => {
    const claims = await claimProjectionJobs(supabase, 10, 120);
    const claim = claims.find(item => item.problem_id === PROBLEM_ID);
    expect(claim).toBeDefined();

    const result = await projectClaimedTimeline(supabase, claim);
    expect(result).toMatchObject({
      committed: true,
      stale: false,
      projectionRevision: 1,
    });

    const { data: projection, error: projectionError } = await supabase
      .from('fsrs_review_schedule_projection')
      .select(
        'card_initialized, fsrs_state, reps, projection_revision, next_review_at'
      )
      .eq('user_id', USER_ID)
      .eq('problem_id', PROBLEM_ID)
      .single();
    assertNoError(projectionError);
    expect(projection).toMatchObject({
      card_initialized: true,
      fsrs_state: 'Review',
      reps: 1,
      projection_revision: 1,
    });
    expect(projection?.next_review_at).not.toBeNull();

    const { data: schedule, error: scheduleError } = await supabase
      .from('review_schedule')
      .select(
        'authority_algorithm, authority_projection_revision, repetition_number, interval_days, next_review_at'
      )
      .eq('user_id', USER_ID)
      .eq('problem_id', PROBLEM_ID)
      .single();
    assertNoError(scheduleError);
    expect(schedule).toMatchObject({
      authority_algorithm: 'sm2',
      authority_projection_revision: 1,
      repetition_number: 4,
      interval_days: 29,
      next_review_at: '2026-09-06T00:00:00+00:00',
    });

    const { data: problem, error: problemError } = await supabase
      .from('problems')
      .select('status, last_reviewed_date')
      .eq('user_id', USER_ID)
      .eq('id', PROBLEM_ID)
      .single();
    assertNoError(problemError);
    expect(problem).toMatchObject({
      status: 'needs_review',
      last_reviewed_date: '2026-08-08T08:00:00+00:00',
    });

    const { count, error: applicationError } = await supabase
      .from('problem_review_schedule_applications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', USER_ID)
      .eq('problem_id', PROBLEM_ID)
      .eq('review_occurrence_id', OCCURRENCE_ID);
    assertNoError(applicationError);
    expect(count).toBe(1);

    const { count: jobs, error: jobsError } = await supabase
      .from('problem_review_projection_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', USER_ID)
      .eq('problem_id', PROBLEM_ID);
    assertNoError(jobsError);
    expect(jobs).toBe(0);

    const { data: shadow, error: shadowError } = await supabase
      .from('fsrs_review_schedule_projection')
      .select('problem_id, projection_revision, timeline_fingerprint')
      .eq('user_id', USER_ID)
      .eq('card_initialized', true);
    assertNoError(shadowError);
    const { data: cutover, error: cutoverError } = await supabase.rpc(
      'cutover_user_review_schedule_to_fsrs',
      {
        p_user_id: USER_ID,
        p_expected_projections: (shadow ?? []).map(item => ({
          problem_id: item.problem_id,
          projection_revision: item.projection_revision,
          timeline_fingerprint: item.timeline_fingerprint,
        })),
      }
    );
    assertNoError(cutoverError);
    expect(cutover).toMatchObject({ authority_mode: 'fsrs', problem_count: 1 });

    const { data: fsrsAuthority, error: fsrsAuthorityError } = await supabase
      .from('review_schedule')
      .select('authority_algorithm, next_review_at')
      .eq('user_id', USER_ID)
      .eq('problem_id', PROBLEM_ID)
      .single();
    assertNoError(fsrsAuthorityError);
    expect(fsrsAuthority).toMatchObject({
      authority_algorithm: 'fsrs',
      next_review_at: projection?.next_review_at,
    });

    const { error: secondReviewError } = await supabase.rpc(
      'record_problem_review_fact',
      {
        p_event_id: SECOND_EVENT_ID,
        p_review_occurrence_id: SECOND_OCCURRENCE_ID,
        p_user_id: USER_ID,
        p_problem_id: PROBLEM_ID,
        p_attempt_id: null,
        p_event_kind: 'review',
        p_human_rating: 'Good',
        p_machine_correctness_snapshot: true,
        p_channel_source: 'web',
        p_device_id: null,
        p_source_request_id: 'fsrs-projector-e2e-000002',
        p_reviewed_at: '2026-08-09T08:00:00.000Z',
        p_initial_idea_revision_id: null,
        p_supersedes_event_id: null,
      }
    );
    assertNoError(secondReviewError);

    const secondClaims = await claimProjectionJobs(supabase, 10, 120);
    const secondClaim = secondClaims.find(
      item => item.problem_id === PROBLEM_ID
    );
    expect(secondClaim).toBeDefined();
    expect(await projectClaimedTimeline(supabase, secondClaim)).toMatchObject({
      committed: true,
      stale: false,
      projectionRevision: 2,
    });

    const { data: updatedAuthority, error: updatedAuthorityError } =
      await supabase
        .from('review_schedule')
        .select('authority_algorithm, authority_projection_revision')
        .eq('user_id', USER_ID)
        .eq('problem_id', PROBLEM_ID)
        .single();
    assertNoError(updatedAuthorityError);
    expect(updatedAuthority).toMatchObject({
      authority_algorithm: 'fsrs',
      authority_projection_revision: 2,
    });

    const { error: cancelError } = await supabase.rpc(
      'cancel_fsrs_authority_cutover',
      {
        p_user_id: USER_ID,
        p_cutover_id: String((cutover as { cutover_id: string }).cutover_id),
      }
    );
    expect(cancelError?.message).toContain('FSRS_CUTOVER_HAS_NEW_REVIEWS');
  });
});
