import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { skipWordStudyObservation } from '@/lib/word-study-service';
import {
  webObservationSchema,
  webWordStudyError,
  webWordStudyInvalidRequest,
  webWordStudySuccess,
} from '@/lib/word-study-web-route';

export async function POST(req: Request) {
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
  const parsed = webObservationSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== 'skipped') {
    return webWordStudyInvalidRequest(requestId);
  }

  try {
    const data = await skipWordStudyObservation(
      createServiceClient(),
      user.id,
      null,
      {
        ...parsed.data,
        boot_id: 'web_word_study_actor',
        firmware_version: 'web',
        capabilities: ['web.word-study-v1'],
      }
    );
    return webWordStudySuccess(requestId, data);
  } catch (error) {
    return webWordStudyError(requestId, error);
  }
}
