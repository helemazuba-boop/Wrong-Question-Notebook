import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
} from '@/lib/notebooks';
import { getNote, updateNote } from '@/lib/notebook-content-service';
import type { Json } from '@/lib/database.types';

const UpdateNoteSchema = z
  .object({
    expected_revision: z.number().int().min(1),
    title: z.string().min(1).max(120).optional(),
    content: z.string().min(1).max(4000).optional(),
    linked_problem_id: z.string().uuid().nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .refine(
    body =>
      body.title !== undefined ||
      body.content !== undefined ||
      body.linked_problem_id !== undefined ||
      body.metadata !== undefined,
    { message: 'No note fields to update' }
  );

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id, noteId } = await params;
    const note = await getNote(supabase, user.id, id, noteId);
    return notebookSuccessResponse({ note });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id, noteId } = await params;
    const parsed = UpdateNoteSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid note update body',
        400
      );
    }
    const note = await updateNote(supabase, user.id, id, noteId, {
      ...parsed.data,
      metadata: parsed.data.metadata as Json | undefined,
    });
    return notebookSuccessResponse({ note });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
