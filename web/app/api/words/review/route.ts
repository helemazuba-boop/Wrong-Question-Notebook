import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  getWordReviewQueue,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';

const ReviewModeSchema = z.enum(['sequential', 'random', 'dictionary']);

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
