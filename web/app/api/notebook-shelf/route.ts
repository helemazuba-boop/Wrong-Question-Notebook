import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  loadNotebookShelf,
  notebookErrorResponse,
  notebookSuccessResponse,
} from '@/lib/notebooks';

export async function GET() {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const items = await loadNotebookShelf(supabase, user.id);
    return notebookSuccessResponse({ items });
  } catch (error) {
    return notebookErrorResponse(error);
  }
}
