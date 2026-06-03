import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  todoErrorResponse,
  todoSuccessResponse,
  TodoToolError,
  updateTodo,
  type TodoPriority,
} from '@/lib/todos';
import type { Json } from '@/lib/database.types';

const PrioritySchema = z.enum(['low', 'normal', 'high']);

const UpdateTodoSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  priority: PrioritySchema.optional(),
  due_at: z.string().datetime().optional().nullable(),
  reminder_at: z.string().datetime().optional().nullable(),
  subject_id: z.string().uuid().optional().nullable(),
  problem_set_id: z.string().uuid().optional().nullable(),
  problem_id: z.string().uuid().optional().nullable(),
  notebook_id: z.string().uuid().optional().nullable(),
  note_id: z.string().uuid().optional().nullable(),
  metadata: z.unknown().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const parsed = UpdateTodoSchema.safeParse(await req.json());
    if (!parsed.success) {
      throw new TodoToolError(
        'invalid_request',
        'Invalid Todo request body',
        400
      );
    }

    const todo = await updateTodo(supabase, user.id, id, {
      ...parsed.data,
      priority: parsed.data.priority as TodoPriority | undefined,
      metadata: parsed.data.metadata as Json | undefined,
    });

    return todoSuccessResponse({ todo });
  } catch (error) {
    return todoErrorResponse(error);
  }
}
