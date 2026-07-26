import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
} from '@/lib/notebooks';
import { getNotebook, updateNotebook } from '@/lib/notebook-content-service';

const UpdateNotebookSchema = z
  .object({
    expected_revision: z.number().int().min(1),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    color: z.string().trim().max(32).nullable().optional(),
    icon: z.string().trim().max(64).nullable().optional(),
    subject_id: z.string().uuid().optional(),
  })
  .refine(
    body =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.color !== undefined ||
      body.icon !== undefined ||
      body.subject_id !== undefined,
    { message: 'No notebook fields to update' }
  );

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const notebook = await getNotebook(supabase, user.id, id);
    return notebookSuccessResponse({ notebook });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = UpdateNotebookSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid notebook update body',
        400
      );
    }
    const notebook = await updateNotebook(supabase, user.id, id, parsed.data);
    return notebookSuccessResponse({ notebook });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
