import { createV3Error, requestIdFromUnknown } from './device-control-v3';
import { WordToolError } from './words';
import { WordStudyServiceError } from './word-study-service';

export function wordStudyErrorResponse(requestId: string, error: unknown) {
  if (error instanceof WordStudyServiceError) {
    return createV3Error(
      requestId,
      error.status,
      error.code,
      error.retryable,
      error.retryable ? 5000 : undefined
    );
  }
  if (error instanceof WordToolError) {
    const retryable =
      error.status >= 500 || error.code === 'pack_revision_changed';
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
    'WORD_STUDY_FAILED',
    false
  );
}
