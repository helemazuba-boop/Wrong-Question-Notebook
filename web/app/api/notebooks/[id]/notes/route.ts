import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  notebookErrorResponse,
  notebookSuccessResponse,
  NotebookToolError,
} from '@/lib/notebooks';
import {
  createNote,
  listNotes,
  NOTE_LIST_ORDERS,
  type NoteListOrder,
} from '@/lib/notebook-content-service';
import type { Json } from '@/lib/database.types';

const CreateNotebookNoteSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(4000),
  linked_problem_id: z.string().uuid().optional().nullable(),
  metadata: z.unknown().optional(),
  client_request_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/)
    .optional(),
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

    const note = await createNote(supabase, user.id, id, {
      title: parsed.data.title,
      content: parsed.data.content,
      source: 'user',
      linked_problem_id: parsed.data.linked_problem_id,
      metadata: parsed.data.metadata as Json | undefined,
      client_request_id: parsed.data.client_request_id,
    });
    return notebookSuccessResponse({ note }, 201);
  } catch (error) {
    return notebookErrorResponse(error);
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const url = new URL(req.url);
    const orderParam = url.searchParams.get('order');
    const order: NoteListOrder | undefined =
      orderParam && (NOTE_LIST_ORDERS as readonly string[]).includes(orderParam)
        ? (orderParam as NoteListOrder)
        : undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    const result = await listNotes(supabase, user.id, id, {
      cursor: url.searchParams.get('cursor'),
      query: url.searchParams.get('query'),
      order,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return notebookSuccessResponse(result);
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
