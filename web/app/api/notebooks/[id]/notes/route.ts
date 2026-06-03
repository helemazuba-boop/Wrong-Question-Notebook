import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createNotebookNoteFromUser,
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
  verifyNotebookOwner,
} from '@/lib/notebooks';
import type { Json } from '@/lib/database.types';

const CreateNotebookNoteSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000),
  linked_problem_id: z.string().uuid().optional().nullable(),
  metadata: z.unknown().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = CreateNotebookNoteSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new NotebookToolError(
        'invalid_request',
        'Invalid notebook note request body',
        400
      );
    }

    const note = await createNotebookNoteFromUser(supabase, user.id, id, {
      ...parsed.data,
      metadata: parsed.data.metadata as Json | undefined,
    });
    return notebookSuccessResponse({ note }, 201);
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    await verifyNotebookOwner(supabase, user.id, id);

    const { data, error } = await supabase
      .from('notebook_notes')
      .select('id, notebook_id, title, content, source, linked_problem_id, metadata, created_at, updated_at')
      .eq('notebook_id', id)
      .eq('user_id', user.id)
      .is('archived_at', null)
      .order('updated_at', { ascending: false });

    if (error) {
      throw new NotebookToolError('database_error', error.message, 500);
    }

    return notebookSuccessResponse({ notes: data || [] });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
