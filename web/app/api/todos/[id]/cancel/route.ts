import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  cancelTodo,
  todoErrorResponse,
  todoSuccessResponse,
} from '@/lib/todos';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const { id } = await params;
    const todo = await cancelTodo(supabase, user.id, id);
    return todoSuccessResponse({ todo });
  } catch (error) {
    return todoErrorResponse(error);
  }
}
