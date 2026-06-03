import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createNotebook,
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
} from '@/lib/notebooks';

const CreateNotebookSchema = z.object({
  subject_id: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).optional().nullable(),
  color: z.string().trim().max(32).optional().nullable(),
  icon: z.string().trim().max(64).optional().nullable(),
});

export async function POST(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const parsed = CreateNotebookSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid notebook request body',
        400
      );
    }

    const notebook = await createNotebook(supabase, user.id, parsed.data);
    return notebookSuccessResponse({ notebook }, 201);
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
