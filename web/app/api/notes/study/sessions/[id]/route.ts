import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import {
  loadWebNoteStudySession,
  setWebNoteStudySessionStatus,
} from '@/lib/note-study-web';
import {
  webNoteStudyError,
  webNoteStudyInvalidRequest,
  webNoteStudySuccess,
} from '@/lib/note-study-web-route';

const paramsSchema = z.object({ id: z.uuid() });
const statusSchema = z.strictObject({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  status: z.enum(['active', 'paused', 'completed', 'abandoned']),
});

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { user } = await requireUser();
  if (!user) return unauthorised();
  const requestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return webNoteStudyInvalidRequest(requestId);
  try {
    const session = await loadWebNoteStudySession(
      createServiceClient(),
      user.id,
      params.data.id
    );
    return webNoteStudySuccess(requestId, { session });
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
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
  const params = paramsSchema.safeParse(await context.params);
  const parsed = statusSchema.safeParse(body);
  if (!params.success || !parsed.success) {
    return webNoteStudyInvalidRequest(requestId);
  }
  try {
    const session = await setWebNoteStudySessionStatus(
      createServiceClient(),
      user.id,
      params.data.id,
      parsed.data.status
    );
    return webNoteStudySuccess(requestId, { session });
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}
