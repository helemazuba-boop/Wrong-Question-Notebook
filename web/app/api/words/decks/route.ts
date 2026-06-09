import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createWordDeck,
  loadWordDecks,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
  type WordDeckSource,
  type WordLexiconType,
} from '@/lib/words';
import type { Json } from '@/lib/database.types';

const DeckSourceSchema = z.enum(['user', 'import', 'ai']);
const LexiconTypeSchema = z.enum(['english_word', 'classical_chinese_term']);

const CreateDeckSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  source: DeckSourceSchema.optional(),
  subject_id: z.string().uuid().optional().nullable(),
  language: z.string().trim().min(2).max(16).optional(),
  target_language: z.string().trim().min(2).max(16).optional(),
  lexicon_type: LexiconTypeSchema.optional(),
  metadata: z.unknown().optional(),
});

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const decks = await loadWordDecks(supabase, user.id, {
      includeSystem: searchParams.get('include_system') !== 'false',
      limit: parseLimit(searchParams.get('limit')),
    });
    return wordSuccessResponse({ decks });
  } catch (error) {
    return wordErrorResponse(error);
  }
}

export async function POST(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const parsed = CreateDeckSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid word deck request body',
        400
      );
    }

    const result = await createWordDeck(supabase, user.id, {
      ...parsed.data,
      source: parsed.data.source as WordDeckSource | undefined,
      lexicon_type: parsed.data.lexicon_type as WordLexiconType | undefined,
      metadata: parsed.data.metadata as Json | undefined,
    });

    return wordSuccessResponse({ deck: result.deck }, 201);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
