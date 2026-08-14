import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  archiveWordDeck,
  updateWordDeck,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';

const ParamsSchema = z.object({ id: z.uuid() });
const UpdateDeckSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    subject_id: z.string().uuid().optional().nullable(),
  })
  .refine(value => Object.keys(value).length > 0);

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
      UpdateDeckSchema.safeParse(rawBody),
    ];
    if (!params.success || !body.success) {
      throw new WordToolError(
        'invalid_request',
        'Invalid word deck update',
        400
      );
    }
    const deck = await updateWordDeck(
      supabase,
      user.id,
      params.data.id,
      body.data
    );
    return wordSuccessResponse({ deck });
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
      throw new WordToolError('invalid_request', 'Invalid word deck id', 400);
    }
    await archiveWordDeck(supabase, user.id, params.data.id);
    return wordSuccessResponse({ archived: true });
  } catch (error) {
    return wordErrorResponse(error);
  }
}
