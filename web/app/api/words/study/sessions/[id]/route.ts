import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import {
  loadWebWordStudySession,
  setWebWordStudySessionStatus,
} from '@/lib/word-study-web';
import {
  webWordStudyError,
  webWordStudyInvalidRequest,
  webWordStudySuccess,
} from '@/lib/word-study-web-route';

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
  if (!params.success) return webWordStudyInvalidRequest(requestId);

  try {
    const session = await loadWebWordStudySession(
      createServiceClient(),
      user.id,
      params.data.id
    );
    return webWordStudySuccess(requestId, { session });
  } catch (error) {
    return webWordStudyError(requestId, error);
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
    return webWordStudyInvalidRequest(
      requestIdFromUnknown(null),
      'Invalid JSON body'
    );
  }
  const requestId = requestIdFromUnknown(body);
  const [params, parsed] = [
    paramsSchema.safeParse(await context.params),
    statusSchema.safeParse(body),
  ];
  if (!params.success || !parsed.success) {
    return webWordStudyInvalidRequest(requestId);
  }

  try {
    const session = await setWebWordStudySessionStatus(
      createServiceClient(),
      user.id,
      params.data.id,
      parsed.data.status
    );
    return webWordStudySuccess(requestId, { session });
  } catch (error) {
    return webWordStudyError(requestId, error);
  }
}
