import { createV3Error, requestIdFromUnknown } from './device-control-v3';
import { ProblemStudyToolError } from './problem-packs';
import { ProblemReviewServiceError } from './problem-review-service';

// Maps problem-study service errors onto the device-control v3 error
// envelope, mirroring noteStudyErrorResponse.
export function problemStudyErrorResponse(requestId: string, error: unknown) {
  if (error instanceof ProblemReviewServiceError) {
    return createV3Error(
      requestId,
      error.status,
      error.code,
      error.retryable,
      error.retryable ? 5000 : undefined
    );
  }
  if (error instanceof ProblemStudyToolError) {
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
    'PROBLEM_STUDY_FAILED',
    false
  );
}
