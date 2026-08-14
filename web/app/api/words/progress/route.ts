import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  loadWordDecks,
  wordErrorResponse,
  wordSuccessResponse,
} from '@/lib/words';
import { loadWordProgressOverview } from '@/lib/word-study-web';

export async function GET() {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const decks = await loadWordDecks(supabase, user.id, {
      includeSystem: true,
      limit: 100,
    });
    const overview = await loadWordProgressOverview(
      createServiceClient(),
      user.id,
      decks.map(deck => deck.id)
    );
    return wordSuccessResponse(overview);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
