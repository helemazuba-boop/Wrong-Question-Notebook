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
import { updateReviewSchedule } from '@/lib/spaced-repetition';
import { getUserTimezone } from '@/lib/timezone-utils';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { fingerprintDeviceControlRequest } from '@/lib/device-control-v3-auth';
import { deterministicDeviceAttemptId } from '@/lib/device-control-v3-idempotency';

const MAX_RESULTS_PER_REQUEST = 200;
const IDEMPOTENCY_ENDPOINT = 'legacy-review-complete';

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
    const now = new Date();
    const nowIso = now.toISOString();
    const userTimezone = await getUserTimezone(userId);
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

      await updateReviewSchedule(
        svc,
        userId,
        result.problem_id,
        result.selected_status,
        userTimezone
      );

      const { error: updateError } = await svc
        .from('problems')
        .update({
          status: result.selected_status,
          last_reviewed_date: nowIso,
          updated_at: nowIso,
        })
        .eq('id', result.problem_id)
        .eq('user_id', userId);

      if (updateError) throw updateError;

      if (result.submitted_answer !== undefined) {
        const attempt = {
          ...(reservedRequestId
            ? {
                id: deterministicDeviceAttemptId(
                  deviceId,
                  reservedRequestId,
                  resultIndex,
                  result.problem_id
                ),
              }
            : {}),
          problem_id: result.problem_id,
          user_id: userId,
          submitted_answer: result.submitted_answer,
          is_correct: result.is_correct ?? false,
          is_self_assessed: true,
          selected_status: result.selected_status,
        };
        const attemptQuery = reservedRequestId
          ? svc
              .from('attempts')
              .upsert(attempt, { onConflict: 'id', ignoreDuplicates: true })
          : svc.from('attempts').insert(attempt);
        const { error: attemptError } = await attemptQuery;
        if (attemptError) throw attemptError;
      }

      processed += 1;
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
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const POST = withSecurity(completeReview, {
  enableRateLimit: false,
  enableRequestValidation: false,
});
