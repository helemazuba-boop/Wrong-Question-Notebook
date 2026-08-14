import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { createWordStudySession } from '@/lib/word-study-service';
import { loadResumableWebWordStudySessions } from '@/lib/word-study-web';
import {
  webWordStudyError,
  webWordStudyInvalidRequest,
  webWordStudySuccess,
} from '@/lib/word-study-web-route';

const requestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const createWebSessionSchema = z.strictObject({
  request_id: requestIdSchema,
  mode: z.enum(['sequential', 'random', 'dictionary']),
  deck_ids: z.array(z.uuid()).min(1).max(32),
  include_mastered: z.boolean(),
  optional_count: z.number().int().min(1).max(500),
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

  try {
    const sessions = await loadResumableWebWordStudySessions(
      createServiceClient(),
      user.id
    );
    return webWordStudySuccess(requestId, { sessions });
  } catch (error) {
    return webWordStudyError(requestId, error);
  }
}

export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const requestId = requestIdFromUnknown(null);
    return webWordStudyInvalidRequest(requestId, 'Invalid JSON body');
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = createWebSessionSchema.safeParse(body);
  if (!parsed.success) return webWordStudyInvalidRequest(requestId);

  try {
    const data = await createWordStudySession(
      createServiceClient(),
      user.id,
      null,
      {
        request_id: parsed.data.request_id,
        boot_id: 'web_word_study_actor',
        firmware_version: 'web',
        capabilities: ['web.word-study-v1'],
        domain: 'word',
        mode: parsed.data.mode,
        scope: {
          deck_ids: parsed.data.deck_ids,
          include_mastered: parsed.data.include_mastered,
        },
        optional_count: parsed.data.optional_count,
        ...(parsed.data.seed ? { seed: parsed.data.seed } : {}),
      }
    );
    return webWordStudySuccess(requestId, data, 201);
  } catch (error) {
    return webWordStudyError(requestId, error);
  }
}
