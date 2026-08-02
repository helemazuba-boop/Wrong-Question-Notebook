import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { loadWordStudyCandidatePage } from '@/lib/word-study-service';
import {
  webWordStudyError,
  webWordStudyInvalidRequest,
  webWordStudySuccess,
} from '@/lib/word-study-web-route';

const paramsSchema = z.object({ id: z.uuid() });
const candidateSchema = z.strictObject({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(20),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(
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
    candidateSchema.safeParse(body),
  ];
  if (!params.success || !parsed.success) {
    return webWordStudyInvalidRequest(requestId);
  }

  try {
    const data = await loadWordStudyCandidatePage(
      createServiceClient(),
      user.id,
      null,
      params.data.id,
      {
        request_id: parsed.data.request_id,
        boot_id: 'web_word_study_actor',
        firmware_version: 'web',
        capabilities: ['web.word-study-v1'],
        cursor: parsed.data.cursor,
        ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      }
    );
    return webWordStudySuccess(requestId, data);
  } catch (error) {
    return webWordStudyError(requestId, error);
  }
}
