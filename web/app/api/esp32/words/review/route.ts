import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  loadEsp32WordReview,
  recordWordReview,
  wordErrorResponse,
  WordToolError,
  type WordReviewMode,
  type WordReviewOutcome,
} from '@/lib/words';
import type { Json } from '@/lib/database.types';

const ReviewModeSchema = z.enum(['sequential', 'random', 'dictionary']);
const ReviewOutcomeSchema = z.enum(['known', 'unknown', 'skip']);
const CardSideSchema = z.enum(['front', 'back']);

const ReviewBodySchema = z.object({
  word_id: z.string().uuid(),
  outcome: ReviewOutcomeSchema,
  mode: ReviewModeSchema.optional(),
  card_side: CardSideSchema.optional(),
  metadata: z.unknown().optional(),
});

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 20;
}

export async function GET(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode') || 'sequential';
    const parsedMode = ReviewModeSchema.safeParse(mode);
    if (!parsedMode.success) {
      throw new WordToolError('invalid_request', 'Invalid review mode', 400);
    }

    const result = await loadEsp32WordReview(
      createServiceClient(),
      authResult.userId,
      {
        mode: parsedMode.data as WordReviewMode,
        limit: parseLimit(searchParams.get('limit')),
      }
    );
    return NextResponse.json(createApiSuccessResponse(result));
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to load word review queue', 500, {
        code: 'word_review_failed',
      }),
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const parsed = ReviewBodySchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid word review body',
        400
      );
    }

    const result = await recordWordReview(
      {
        userId: authResult.userId,
        deviceId: authResult.deviceId,
        supabase: createServiceClient(),
      },
      {
        ...parsed.data,
        outcome: parsed.data.outcome as WordReviewOutcome,
        mode: parsed.data.mode as WordReviewMode | undefined,
        metadata:
          parsed.data.metadata &&
          typeof parsed.data.metadata === 'object' &&
          !Array.isArray(parsed.data.metadata)
            ? ({
                ...(parsed.data.metadata as Record<string, Json>),
                ...(parsed.data.card_side
                  ? { card_side: parsed.data.card_side }
                  : {}),
              } as Json)
            : parsed.data.card_side
              ? ({ card_side: parsed.data.card_side } as Json)
              : (parsed.data.metadata as Json | undefined),
      }
    );

    return NextResponse.json(
      createApiSuccessResponse({
        word_id: result.word_id,
        status: result.status,
        due_at: result.due_at,
        actions: result.actions,
      })
    );
  } catch (error) {
    if (error instanceof WordToolError) return wordErrorResponse(error);
    return NextResponse.json(
      createApiErrorResponse('Failed to record word review', 500, {
        code: 'word_review_failed',
      }),
      { status: 500 }
    );
  }
}
