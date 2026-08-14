import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { createNoteStudySession } from '@/lib/note-study-service';
import { loadResumableWebNoteStudySessions } from '@/lib/note-study-web';
import {
  webNoteStudyError,
  webNoteStudyInvalidRequest,
  webNoteStudySuccess,
} from '@/lib/note-study-web-route';

const requestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const createWebSessionSchema = z.strictObject({
  request_id: requestIdSchema,
  mode: z.enum(['sequential', 'recent']),
  notebook_ids: z.array(z.uuid()).min(1).max(32),
  optional_count: z.number().int().min(1).max(500).optional(),
  seed: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export async function GET(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const notebookId = new URL(req.url).searchParams.get('notebook_id');
  if (notebookId && !z.uuid().safeParse(notebookId).success) {
    return webNoteStudyInvalidRequest(requestId);
  }
  try {
    const sessions = await loadResumableWebNoteStudySessions(
      createServiceClient(),
      user.id,
      { ...(notebookId ? { notebook_id: notebookId } : {}) }
    );
    return webNoteStudySuccess(requestId, { sessions });
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}

export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return webNoteStudyInvalidRequest(
      requestIdFromUnknown(null),
      'Invalid JSON body'
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = createWebSessionSchema.safeParse(body);
  if (!parsed.success) return webNoteStudyInvalidRequest(requestId);

  try {
    const data = await createNoteStudySession(
      createServiceClient(),
      user.id,
      null,
      {
        request_id: parsed.data.request_id,
        boot_id: 'web_note_study_actor',
        firmware_version: 'web',
        capabilities: ['web.note-study-v1'],
        domain: 'note',
        mode: parsed.data.mode,
        scope: {
          notebook_ids: parsed.data.notebook_ids,
          include_archived: false,
        },
        ...(parsed.data.optional_count
          ? { optional_count: parsed.data.optional_count }
          : {}),
        ...(parsed.data.seed ? { seed: parsed.data.seed } : {}),
      }
    );
    return webNoteStudySuccess(requestId, data, 201);
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}
