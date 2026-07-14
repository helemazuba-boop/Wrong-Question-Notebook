import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  loadWrongWords,
  wordErrorResponse,
  wordSuccessResponse,
} from '@/lib/words';

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const data = await loadWrongWords(supabase, user.id, {
      limit: parseLimit(searchParams.get('limit')),
    });
    return wordSuccessResponse(data);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
