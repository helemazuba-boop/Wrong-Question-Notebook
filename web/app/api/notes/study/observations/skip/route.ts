import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { advanceWebNoteStudyObservation } from '@/lib/note-study-web';
import {
  webNoteObservationSchema,
  webNoteStudyError,
  webNoteStudyInvalidRequest,
  webNoteStudySuccess,
  withServerTiming,
} from '@/lib/note-study-web-route';

export async function POST(req: Request) {
  const authStartedAt = performance.now();
  const { user } = await requireUser();
  const authDurationMs = performance.now() - authStartedAt;
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
  const parsed = webNoteObservationSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== 'skipped') {
    return webNoteStudyInvalidRequest(requestId);
  }
  const studyStartedAt = performance.now();
  try {
    const data = await advanceWebNoteStudyObservation(
      createServiceClient(),
      user.id,
      parsed.data
    );
    return withServerTiming(webNoteStudySuccess(requestId, data), [
      { name: 'auth', durationMs: authDurationMs },
      { name: 'study', durationMs: performance.now() - studyStartedAt },
    ]);
  } catch (error) {
    return withServerTiming(webNoteStudyError(requestId, error), [
      { name: 'auth', durationMs: authDurationMs },
      { name: 'study', durationMs: performance.now() - studyStartedAt },
    ]);
  }
}
