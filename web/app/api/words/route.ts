import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  searchWords,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';

const UuidSchema = z.string().uuid();

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 20;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const deckId = searchParams.get('deck_id');
    if (deckId && !UuidSchema.safeParse(deckId).success) {
      throw new WordToolError('invalid_request', 'Invalid deck_id', 400);
    }

    const data = await searchWords(supabase, user.id, {
      deck_id: deckId,
      q: searchParams.get('q'),
      prefix: searchParams.get('prefix'),
      limit: parseLimit(searchParams.get('limit')),
    });
    return wordSuccessResponse(data);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
