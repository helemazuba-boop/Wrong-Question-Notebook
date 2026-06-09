import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  importWordEntriesToDeck,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';
import type { Json } from '@/lib/database.types';

const ImportEntrySchema = z.object({
  word: z.string().trim().min(1).max(80),
  phonetic: z.string().trim().max(120).optional().nullable(),
  meaning: z.string().trim().min(1).max(1000),
  example: z.string().trim().max(1000).optional().nullable(),
  example_translation: z.string().trim().max(1000).optional().nullable(),
  part_of_speech: z.string().trim().max(64).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  sort_index: z.number().int().min(0).max(1000000).optional(),
  metadata: z.unknown().optional(),
});

const ImportBodySchema = z.object({
  entries: z.array(ImportEntrySchema).min(1).max(4000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = ImportBodySchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid word import request body',
        400
      );
    }

    const result = await importWordEntriesToDeck(
      supabase,
      user.id,
      id,
      parsed.data.entries.map(entry => ({
        ...entry,
        metadata: entry.metadata as Json | undefined,
      }))
    );

    return wordSuccessResponse(result, 201);
  } catch (error) {
    return wordErrorResponse(error);
  }
}
