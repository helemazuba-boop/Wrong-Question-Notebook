import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  getWordDetail,
  wordErrorResponse,
  wordSuccessResponse,
  WordToolError,
} from '@/lib/words';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

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
