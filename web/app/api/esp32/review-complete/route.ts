import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
  isValidUuid,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { revalidateUserReviewSchedule } from '@/lib/cache-invalidation';
import type { Json } from '@/lib/database.types';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { fingerprintDeviceControlRequest } from '@/lib/device-control-v3-auth';
import {
  deterministicDeviceAttemptId,
  deterministicDeviceReviewId,
} from '@/lib/device-control-v3-idempotency';

const MAX_RESULTS_PER_REQUEST = 200;
const IDEMPOTENCY_ENDPOINT = 'legacy-review-complete';

function legacyResultRequestId(
  requestId: string,
  resultIndex: number,
  result: {
    problem_id: string;
    selected_status: 'wrong' | 'needs_review' | 'mastered';
    is_correct?: boolean;
    submitted_answer?: Json;
  }
): string {
  const suffix = fingerprintDeviceControlRequest({
    result_index: resultIndex,
    result,
  }).slice(0, 16);
  return `${requestId.slice(0, 47)}_${suffix}`;
}

function fallbackResultRequestId(
  requestFingerprint: string,
  resultIndex: number,
  result: {
    problem_id: string;
    selected_status: 'wrong' | 'needs_review' | 'mastered';
    is_correct?: boolean;
    submitted_answer?: Json;
  }
): string {
  return `legacy_${fingerprintDeviceControlRequest({
    request_fingerprint: requestFingerprint,
    result_index: resultIndex,
    result,
  }).slice(0, 56)}`;
}

function replayReviewResponse(
  replay: {
    endpoint: string;
    request_fingerprint: string;
    http_status: number;
    response_body: Json;
  },
  requestFingerprint: string
): NextResponse {
  if (
    replay.endpoint !== IDEMPOTENCY_ENDPOINT ||
    replay.request_fingerprint !== requestFingerprint
  ) {
    return NextResponse.json(
      createApiErrorResponse('Request ID was reused', 409),
      { status: 409 }
    );
  }
  return NextResponse.json(replay.response_body, {
    status: replay.http_status,
  });
}

async function completeReview(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId, deviceId } = authResult;
  let reservedRequestId: string | null = null;

  try {
    const body = await req.json();
    const { results } = body as {
      results?: Array<{
        problem_id: string;
        selected_status: 'wrong' | 'needs_review' | 'mastered';
        is_correct?: boolean;
        submitted_answer?: Json;
      }>;
    };
    const requestId = req.headers.get('X-WQN-Request-Id');
    const idempotencyEnabled =
      typeof requestId === 'string' &&
      requestId.length >= 16 &&
      requestId.length <= 64 &&
      /^[A-Za-z0-9_-]+$/.test(requestId);
    const requestFingerprint = fingerprintDeviceControlRequest(body);

    if (!results || !Array.isArray(results) || results.length === 0) {
      return NextResponse.json(
        createApiErrorResponse(
          'Results array is required and must not be empty',
          400
        ),
        { status: 400 }
      );
    }

    if (results.length > MAX_RESULTS_PER_REQUEST) {
      return NextResponse.json(
        createApiErrorResponse(
          `Results array must contain at most ${MAX_RESULTS_PER_REQUEST} items`,
          400
        ),
        { status: 400 }
      );
    }

    const svc = createServiceClient();
    if (idempotencyEnabled) {
      const { data: replay, error: replayError } = await svc
        .from('esp32_request_idempotency')
        .select('endpoint, request_fingerprint, http_status, response_body')
        .eq('device_id', deviceId)
        .eq('request_id', requestId)
        .maybeSingle();
      if (replayError) throw replayError;
      if (replay) {
        return replayReviewResponse(replay, requestFingerprint);
      }

      const processingResponse = createApiErrorResponse(
        'Request is still processing',
        503
      );
      const { error: reservationError } = await svc
        .from('esp32_request_idempotency')
        .insert({
          device_id: deviceId,
          request_id: requestId,
          endpoint: IDEMPOTENCY_ENDPOINT,
          request_fingerprint: requestFingerprint,
          http_status: 503,
          response_body: processingResponse as unknown as Json,
        });
      if (reservationError?.code === '23505') {
        const { data: concurrentReplay, error: concurrentReplayError } =
          await svc
            .from('esp32_request_idempotency')
            .select('endpoint, request_fingerprint, http_status, response_body')
            .eq('device_id', deviceId)
            .eq('request_id', requestId)
            .single();
        if (concurrentReplayError) throw concurrentReplayError;
        return replayReviewResponse(concurrentReplay, requestFingerprint);
      }
      if (reservationError) throw reservationError;
      reservedRequestId = requestId;
    }
    const validStatuses = new Set(['wrong', 'needs_review', 'mastered']);
    let processed = 0;

    for (const [resultIndex, result] of results.entries()) {
      if (!isValidUuid(result.problem_id)) continue;
      if (!validStatuses.has(result.selected_status)) continue;

      const { data: problem, error: problemError } = await svc
        .from('problems')
        .select('id')
        .eq('id', result.problem_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (problemError) throw problemError;
      if (!problem) continue;

      const stableRequestIdentity = reservedRequestId ?? requestFingerprint;
      const attemptId =
        result.submitted_answer !== undefined
          ? deterministicDeviceAttemptId(
              deviceId,
              stableRequestIdentity,
              resultIndex,
              result.problem_id
            )
          : null;
      if (attemptId) {
        const attempt = {
          id: attemptId,
          problem_id: result.problem_id,
          user_id: userId,
          submitted_answer: result.submitted_answer as Json,
          is_correct: result.is_correct ?? null,
          is_self_assessed: true,
        };
        const { error: attemptError } = await svc
          .from('attempts')
          .upsert(attempt, { onConflict: 'id', ignoreDuplicates: true });
        if (attemptError) throw attemptError;
      }

      const rating =
        result.selected_status === 'wrong'
          ? 'Again'
          : result.selected_status === 'needs_review'
            ? 'Hard'
            : 'Good';
      const sourceRequestId = reservedRequestId
        ? legacyResultRequestId(reservedRequestId, resultIndex, result)
        : fallbackResultRequestId(requestFingerprint, resultIndex, result);
      const reviewOccurrenceId = deterministicDeviceReviewId(
        deviceId,
        stableRequestIdentity,
        resultIndex
      );
      const existingReview = await svc
        .from('problem_review_events')
        .select(
          'id, review_occurrence_id, problem_id, attempt_id, event_kind, human_rating, machine_correctness_snapshot, channel_source'
        )
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .eq('source_request_id', sourceRequestId)
        .maybeSingle();
      if (existingReview.error) throw existingReview.error;

      let reviewRecorded = false;
      if (existingReview.data) {
        const replay = existingReview.data;
        if (
          replay.review_occurrence_id !== reviewOccurrenceId ||
          replay.problem_id !== result.problem_id ||
          replay.attempt_id !== attemptId ||
          replay.event_kind !== 'review' ||
          replay.human_rating !== rating ||
          replay.machine_correctness_snapshot !== (result.is_correct ?? null) ||
          replay.channel_source !== 'device'
        ) {
          throw new Error('REVIEW_REQUEST_ID_REUSED');
        }
        reviewRecorded = true;
      } else {
        const reviewedAt = new Date().toISOString();
        const { error: reviewError } = await svc.rpc(
          'record_problem_review_fact',
          {
            p_event_id: deterministicDeviceReviewId(
              deviceId,
              `${stableRequestIdentity}_event`,
              resultIndex
            ),
            p_review_occurrence_id: reviewOccurrenceId,
            p_user_id: userId,
            p_problem_id: result.problem_id,
            p_attempt_id: attemptId,
            p_event_kind: 'review',
            p_human_rating: rating,
            p_machine_correctness_snapshot: result.is_correct ?? null,
            p_channel_source: 'device',
            p_device_id: deviceId,
            p_source_request_id: sourceRequestId,
            p_reviewed_at: reviewedAt,
            p_initial_idea_revision_id: null,
            p_supersedes_event_id: null,
          }
        );
        if (reviewError) {
          if (reviewError.message.includes('REVIEW_REQUEST_ID_REUSED')) {
            const replayLookup = await svc
              .from('problem_review_events')
              .select(
                'review_occurrence_id, problem_id, attempt_id, event_kind, human_rating, machine_correctness_snapshot, channel_source'
              )
              .eq('user_id', userId)
              .eq('device_id', deviceId)
              .eq('source_request_id', sourceRequestId)
              .maybeSingle();
            if (replayLookup.error) throw replayLookup.error;
            const replay = replayLookup.data;
            if (
              replay &&
              replay.review_occurrence_id === reviewOccurrenceId &&
              replay.problem_id === result.problem_id &&
              replay.attempt_id === attemptId &&
              replay.event_kind === 'review' &&
              replay.human_rating === rating &&
              replay.machine_correctness_snapshot ===
                (result.is_correct ?? null) &&
              replay.channel_source === 'device'
            ) {
              reviewRecorded = true;
            }
          }
          if (!reviewRecorded) throw reviewError;
        } else {
          reviewRecorded = true;
        }
      }

      if (reviewRecorded) processed += 1;
    }

    // Invalidate cache
    try {
      await revalidateUserReviewSchedule(userId);
    } catch {
      // Best effort
    }

    const responseBody = createApiSuccessResponse({
      message: 'Review results saved',
      processed,
    });
    if (reservedRequestId) {
      const { error: storeError } = await svc
        .from('esp32_request_idempotency')
        .update({
          http_status: 200,
          response_body: responseBody,
        })
        .eq('device_id', deviceId)
        .eq('request_id', reservedRequestId)
        .eq('endpoint', IDEMPOTENCY_ENDPOINT)
        .eq('request_fingerprint', requestFingerprint);
      if (storeError) throw storeError;
      reservedRequestId = null;
    }
    return NextResponse.json(responseBody);
  } catch (error) {
    if (reservedRequestId) {
      // All writes above are retry-safe; release an unfinished reservation so
      // the device can resume after a process/network failure.
      await createServiceClient()
        .from('esp32_request_idempotency')
        .delete()
        .eq('device_id', deviceId)
        .eq('request_id', reservedRequestId)
        .eq('endpoint', IDEMPOTENCY_ENDPOINT);
    }
    const { message, status } = handleAsyncError(error);
    const responseStatus = message.includes('REVIEW_REQUEST_ID_REUSED')
      ? 409
      : status;
    return NextResponse.json(
      createApiErrorResponse(
        message.includes('REVIEW_REQUEST_ID_REUSED')
          ? 'Request ID was reused'
          : message,
        responseStatus
      ),
      { status: responseStatus }
    );
  }
}

export const POST = withSecurity(completeReview, {
  enableRateLimit: false,
  enableRequestValidation: false,
});
