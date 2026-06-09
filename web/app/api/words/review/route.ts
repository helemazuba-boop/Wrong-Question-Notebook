import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  getWordReviewQueue,
  recordWordReview,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';
import type { Json } from '@/lib/database.types';

const ReviewModeSchema = z.enum(['sequential', 'random', 'dictionary']);
const ReviewOutcomeSchema = z.enum(['known', 'unknown', 'skip']);
const ReviewSourceSchema = z.enum(['web', 'device', 'ai', 'system']);
const CardSideSchema = z.enum(['front', 'back']);

const RecordWordReviewSchema = z.object({
  word_id: z.string().uuid(),
  outcome: ReviewOutcomeSchema,
  mode: ReviewModeSchema.optional(),
  source: ReviewSourceSchema.optional(),
  card_side: CardSideSchema.optional(),
  metadata: z.unknown().optional(),
});

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode') || 'sequential';
    const parsedMode = ReviewModeSchema.safeParse(mode);
    if (!parsedMode.success) {
      throw new WordToolError('invalid_request', 'Invalid review mode', 400);
    }

    const data = await getWordReviewQueue(supabase, user.id, {
      deck_id: searchParams.get('deck_id'),
      mode: parsedMode.data,
      limit: parseLimit(searchParams.get('limit')),
    });

    return wordSuccessResponse(data);
  } catch (error) {
    return wordErrorResponse(error);
  }
}

export async function POST(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const parsed = RecordWordReviewSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid Word review request body',
        400
      );
    }

    const data = await recordWordReview(
      { userId: user.id, supabase, source: 'web' },
      {
        ...parsed.data,
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
              : {},
      }
    );

    return wordSuccessResponse({
      word_id: data.word_id,
      status: data.status,
      due_at: data.due_at,
      actions: data.actions,
    });
  } catch (error) {
    return wordErrorResponse(error);
  }
}
