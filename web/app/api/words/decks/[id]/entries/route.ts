import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  addWordEntryToDeck,
  listWordEntriesForDeck,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';
import type { Json } from '@/lib/database.types';

const CreateEntrySchema = z.object({
  word: z.string().trim().min(1).max(80),
  phonetic: z.string().trim().max(120).optional().nullable(),
  meaning: z.string().trim().min(1).max(1000),
  example: z.string().trim().max(1000).optional().nullable(),
  example_translation: z.string().trim().max(1000).optional().nullable(),
  part_of_speech: z.string().trim().max(80).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  sort_index: z.number().int().optional(),
  metadata: z.unknown().optional(),
});

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

function parseOffset(value: string | null): number {
  const parsed = Number.parseInt(value || '0', 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const result = await listWordEntriesForDeck(supabase, user.id, id, {
      q: searchParams.get('q'),
      limit: parseLimit(searchParams.get('limit')),
      offset: parseOffset(searchParams.get('offset')),
    });
    return wordSuccessResponse({
      entries: result.entries,
      count: result.count,
    });
  } catch (error) {
    return wordErrorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = CreateEntrySchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid word entry request body',
        400
      );
    }

    const result = await addWordEntryToDeck(supabase, user.id, id, {
      ...parsed.data,
      metadata: parsed.data.metadata as Json | undefined,
    });
    return wordSuccessResponse(result, 201);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
