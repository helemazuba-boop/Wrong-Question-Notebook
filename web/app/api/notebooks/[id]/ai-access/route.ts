import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
  upsertNotebookAiAccess,
} from '@/lib/notebooks';

const UpdateAiAccessSchema = z.object({
  can_read: z.boolean().default(false),
  can_create: z.boolean().default(false),
  can_update: z.boolean().default(false),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = UpdateAiAccessSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid AI access request body',
        400
      );
    }

    const access = await upsertNotebookAiAccess(
      supabase,
      user.id,
      id,
      parsed.data
    );
    return notebookSuccessResponse({ access });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
