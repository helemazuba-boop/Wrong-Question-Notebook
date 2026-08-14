import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { requestIdFromUnknown } from '@/lib/device-control-v3';
import { skipNoteStudyObservation } from '@/lib/note-study-service';
import {
  webNoteObservationSchema,
  webNoteStudyError,
  webNoteStudyInvalidRequest,
  webNoteStudySuccess,
} from '@/lib/note-study-web-route';

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
  const parsed = webNoteObservationSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== 'skipped') {
    return webNoteStudyInvalidRequest(requestId);
  }
  try {
    const data = await skipNoteStudyObservation(
      createServiceClient(),
      user.id,
      null,
      {
        ...parsed.data,
        boot_id: 'web_note_study_actor',
        firmware_version: 'web',
        capabilities: ['web.note-study-v1'],
      }
    );
    return webNoteStudySuccess(requestId, data);
  } catch (error) {
    return webNoteStudyError(requestId, error);
  }
}
