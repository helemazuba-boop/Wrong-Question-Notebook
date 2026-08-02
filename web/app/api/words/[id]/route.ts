import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  deleteWordEntry,
  getWordDetail,
  updateWordEntry,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});
const UpdateWordSchema = z
  .object({
    word: z.string().trim().min(1).max(80).optional(),
    phonetic: z.string().trim().max(120).optional().nullable(),
    meaning: z.string().trim().min(1).max(1000).optional(),
    example: z.string().trim().max(1000).optional().nullable(),
    example_translation: z.string().trim().max(1000).optional().nullable(),
    part_of_speech: z.string().trim().max(80).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  })
  .refine(value => Object.keys(value).length > 0);

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const parsed = ParamsSchema.safeParse(await context.params);
    if (!parsed.success) {
      throw new WordToolError('invalid_request', 'Invalid word id', 400);
    }

    const word = await getWordDetail(supabase, user.id, parsed.data.id);
    return wordSuccessResponse({ word });
  } catch (error) {
    return wordErrorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const rawBody = await req.json().catch(() => null);
    const [params, body] = [
      ParamsSchema.safeParse(await context.params),
      UpdateWordSchema.safeParse(rawBody),
    ];
    if (!params.success || !body.success) {
      throw new WordToolError('invalid_request', 'Invalid word update', 400);
    }
    const word = await updateWordEntry(
      supabase,
      user.id,
      params.data.id,
      body.data
    );
    return wordSuccessResponse({ word });
  } catch (error) {
    return wordErrorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) {
      throw new WordToolError('invalid_request', 'Invalid word id', 400);
    }
    await deleteWordEntry(supabase, user.id, params.data.id);
    return wordSuccessResponse({ deleted: true });
  } catch (error) {
    return wordErrorResponse(error);
  }
}
