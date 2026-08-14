import { after, NextResponse } from 'next/server';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { runProjectionBatch } from '@/lib/fsrs/projector';
import {
  correctWebProblemReviewRating,
  recordWebProblemReviewRating,
} from '@/lib/problem-review-service';
import {
  ProblemReviewRatingCorrectionDto,
  ProblemReviewRatingDto,
} from '@/lib/schemas';
import { withSecurity } from '@/lib/security-middleware';
import { createServiceClient } from '@/lib/supabase-utils';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';

function mapReviewError(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Review Rating failed';
  if (
    message.includes('REVIEW_ATTEMPT_NOT_OWNED') ||
    message.includes('REVIEW_TERMINAL_EVENT_NOT_OWNED')
  ) {
    return NextResponse.json(createApiErrorResponse('Review not found', 404), {
      status: 404,
    });
  }
  if (
    message.includes('REVIEW_REQUEST_ID_REUSED') ||
    message.includes('REVIEW_SUPERSESSION_CONFLICT')
  ) {
    return NextResponse.json(createApiErrorResponse('Review conflict', 409), {
      status: 409,
    });
  }
  return NextResponse.json(createApiErrorResponse(message, 500), {
    status: 500,
  });
}

function wakeProjector() {
  after(async () => {
    try {
      await runProjectionBatch({ limit: 5, leaseSeconds: 120, concurrency: 1 });
    } catch (error) {
      console.error(
        '[problem-review-projector] best-effort wake failed:',
        error
      );
    }
  });
}

async function parseRequestJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function createRating(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const body = await parseRequestJson(req);
  const parsed = ProblemReviewRatingDto.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid request body',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }

  try {
    const result = await recordWebProblemReviewRating({
      ownerSupabase: supabase,
      serviceSupabase: createServiceClient(),
      userId: user.id,
      attemptId: parsed.data.attempt_id,
      rating: parsed.data.rating,
      reviewOccurrenceId: parsed.data.review_occurrence_id,
      requestId: parsed.data.request_id,
    });
    wakeProjector();
    return NextResponse.json(createApiSuccessResponse(result), { status: 201 });
  } catch (error) {
    return mapReviewError(error);
  }
}

async function correctRating(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const body = await parseRequestJson(req);
  const parsed = ProblemReviewRatingCorrectionDto.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse(
        'Invalid request body',
        400,
        parsed.error.flatten()
      ),
      { status: 400 }
    );
  }

  try {
    const result = await correctWebProblemReviewRating({
      ownerSupabase: supabase,
      serviceSupabase: createServiceClient(),
      userId: user.id,
      rating: parsed.data.rating,
      reviewOccurrenceId: parsed.data.review_occurrence_id,
      terminalEventId: parsed.data.terminal_event_id,
      requestId: parsed.data.request_id,
    });
    wakeProjector();
    return NextResponse.json(createApiSuccessResponse(result));
  } catch (error) {
    return mapReviewError(error);
  }
}

export const POST = withSecurity(createRating, { rateLimitType: 'api' });
export const PATCH = withSecurity(correctRating, { rateLimitType: 'api' });
