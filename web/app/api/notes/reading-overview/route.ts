import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import {
  loadNotebookReadSummaries,
  loadRecentNoteReads,
} from '@/lib/note-study-web';
import {
  webNoteStudyError,
  webNoteStudyInvalidRequest,
  webNoteStudySuccess,
} from '@/lib/note-study-web-route';

const notebookIdSchema = z.uuid();

export async function GET(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const notebookId = new URL(req.url).searchParams.get('notebook_id');
  if (notebookId && !notebookIdSchema.safeParse(notebookId).success) {
    return webNoteStudyInvalidRequest(requestId);
  }
  try {
    const supabase = createServiceClient();
    const [summaries, recent] = await Promise.all([
      notebookId
        ? loadNotebookReadSummaries(supabase, user.id, [notebookId])
        : Promise.resolve({}),
      loadRecentNoteReads(supabase, user.id, {
        ...(notebookId ? { notebook_id: notebookId } : {}),
      }),
    ]);
    return webNoteStudySuccess(requestId, { summaries, recent });
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}
