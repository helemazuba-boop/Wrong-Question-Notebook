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

async function authenticateDevice(
  req: Request
): Promise<{ userId: string; deviceId: string } | NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      createApiErrorResponse('Missing or invalid Authorization header', 401),
      { status: 401 }
    );
  }

  const token = authHeader.slice(7);
  const svc = createServiceClient();
  const { data: device } = await svc
    .from('esp32_devices')
    .select('id, user_id')
    .eq('access_token', token)
    .single();

  if (!device) {
    return NextResponse.json(
      createApiErrorResponse('Invalid access token', 401),
      { status: 401 }
    );
  }

  return { userId: device.user_id, deviceId: device.id };
}

async function completeReview(req: Request) {
  const authResult = await authenticateDevice(req);
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
        createApiErrorResponse('Results array is required and must not be empty', 400),
        { status: 400 }
      );
    }

    const svc = createServiceClient();
    const now = new Date().toISOString();
    const validStatuses = ['wrong', 'needs_review', 'mastered'];

    for (const result of results) {
      if (!isValidUuid(result.problem_id)) continue;
      if (!validStatuses.includes(result.selected_status)) continue;

      // Upsert review_schedule for each problem
      // Calculate next review interval based on status
      let intervalDays: number;
      let easeFactor: number;

      if (result.selected_status === 'mastered') {
        // Long interval for mastered
        intervalDays = 30;
        easeFactor = 2.5;
      } else if (result.selected_status === 'needs_review') {
        intervalDays = 3;
        easeFactor = 2.0;
      } else {
        // Wrong - shorter interval
        intervalDays = 1;
        easeFactor = 1.3;
      }

      const nextReviewAt = new Date();
      nextReviewAt.setDate(nextReviewAt.getDate() + intervalDays);

      // Upsert review_schedule
      await svc
        .from('review_schedule')
        .upsert(
          {
            problem_id: result.problem_id,
            user_id: userId,
            ease_factor: easeFactor,
            interval_days: intervalDays,
            last_reviewed_at: now,
            next_review_at: nextReviewAt.toISOString(),
            repetition_number: 1,
          },
          { onConflict: 'problem_id,user_id' }
        );

      // Update problem status
      await svc
        .from('problems')
        .update({
          status: result.selected_status,
          last_reviewed_date: now.split('T')[0],
          updated_at: now,
        })
        .eq('id', result.problem_id)
        .eq('user_id', userId);

      // Insert attempt record
      if (result.submitted_answer !== undefined) {
        await svc.from('attempts').insert({
          problem_id: result.problem_id,
          user_id: userId,
          submitted_answer: result.submitted_answer,
          is_correct: result.is_correct ?? false,
          is_self_assessed: true,
          selected_status: result.selected_status,
        });
      }
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
        processed: results.length,
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
