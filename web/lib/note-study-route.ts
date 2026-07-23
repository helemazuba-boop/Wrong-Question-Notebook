import { createV3Error, requestIdFromUnknown } from './device-control-v3';
import { NotebookToolError } from './notebooks';
import { NoteStudyServiceError } from './note-study-service';

// Maps note-study service errors onto the device-control v3 error envelope,
// mirroring wordStudyErrorResponse.
export function noteStudyErrorResponse(requestId: string, error: unknown) {
  if (error instanceof NoteStudyServiceError) {
    return createV3Error(
      requestId,
      error.status,
      error.code,
      error.retryable,
      error.retryable ? 5000 : undefined
    );
  }
  if (error instanceof NotebookToolError) {
    const retryable = error.status >= 500;
    return createV3Error(
      requestId,
      error.status,
      error.code.toUpperCase(),
      retryable,
      retryable ? 1000 : undefined
    );
  }
  return createV3Error(
    requestId || requestIdFromUnknown(null),
    500,
    'NOTE_STUDY_FAILED',
    false
  );
}
