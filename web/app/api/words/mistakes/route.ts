import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  loadWrongWords,
  wordErrorResponse,
  wordSuccessResponse,
} from '@/lib/words';
import { loadWordMistakeLinks } from '@/lib/word-study-web';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const wordEntryId = searchParams.get('word_entry_id');
    if (wordEntryId) {
      const mistakes = await loadWordMistakeLinks(supabase, user.id, [
        wordEntryId,
      ]);
      return wordSuccessResponse({
        mistake: mistakes.get(wordEntryId) || null,
      });
    }
    const data = await loadWrongWords(supabase, user.id, {
      limit: parseLimit(searchParams.get('limit')),
    });
    return wordSuccessResponse(data);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
