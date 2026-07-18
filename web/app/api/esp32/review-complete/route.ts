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

const MAX_RESULTS_PER_REQUEST = 200;

async function completeReview(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId } = authResult;

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
    const now = new Date();
    const nowIso = now.toISOString();
    const userTimezone = await getUserTimezone(userId);
    const validStatuses = new Set(['wrong', 'needs_review', 'mastered']);
    let processed = 0;

    for (const result of results) {
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
        const { error: attemptError } = await svc.from('attempts').insert({
          problem_id: result.problem_id,
          user_id: userId,
          submitted_answer: result.submitted_answer,
          is_correct: result.is_correct ?? false,
          is_self_assessed: true,
          selected_status: result.selected_status,
        });
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

    return NextResponse.json(
      createApiSuccessResponse({
        message: 'Review results saved',
        processed,
      })
    );
  } catch (error) {
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
