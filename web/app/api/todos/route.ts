import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createTodo,
  loadTodos,
  todoErrorResponse,
  todoSuccessResponse,
  TodoToolError,
  type TodoPriority,
  type TodoStatus,
} from '@/lib/todos';
import type { Json } from '@/lib/database.types';

const StatusSchema = z.enum(['pending', 'completed', 'cancelled', 'all']);
const PrioritySchema = z.enum(['low', 'normal', 'high']);

const CreateTodoSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  priority: PrioritySchema.optional(),
  due_at: z.string().datetime().optional().nullable(),
  reminder_at: z.string().datetime().optional().nullable(),
  subject_id: z.string().uuid().optional().nullable(),
  problem_set_id: z.string().uuid().optional().nullable(),
  problem_id: z.string().uuid().optional().nullable(),
  notebook_id: z.string().uuid().optional().nullable(),
  note_id: z.string().uuid().optional().nullable(),
  word_deck_id: z.string().uuid().optional().nullable(),
  word_entry_id: z.string().uuid().optional().nullable(),
  metadata: z.unknown().optional(),
});

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '20', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;
}

export async function GET(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get('status') || 'pending';
    const status = StatusSchema.safeParse(statusParam);
    if (!status.success) {
      throw new TodoToolError('invalid_request', 'Invalid Todo status', 400);
    }

    const todos = await loadTodos(supabase, user.id, {
      status: status.data as TodoStatus | 'all',
      subject_id: searchParams.get('subject_id'),
      due_before: searchParams.get('due_before'),
      limit: parseLimit(searchParams.get('limit')),
    });

    return todoSuccessResponse({ todos });
  } catch (error) {
    return todoErrorResponse(error);
  }
}

export async function POST(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const parsed = CreateTodoSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new TodoToolError(
        'invalid_request',
        'Invalid Todo request body',
        400
      );
    }

    const todo = await createTodo(supabase, user.id, {
      ...parsed.data,
      priority: parsed.data.priority as TodoPriority | undefined,
      metadata: parsed.data.metadata as Json | undefined,
      source: 'manual',
      created_by: 'user',
    });

    return todoSuccessResponse({ todo }, 201);
  } catch (error) {
    return todoErrorResponse(error);
  }
}
