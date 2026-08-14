import { createV3Error, requestIdFromUnknown } from './device-control-v3';
import { DeviceContentArtifactError } from './device-content-artifacts';
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
  if (error instanceof DeviceContentArtifactError) {
    const retryable =
      error.code === 'artifact_storage_error' && error.status >= 500;
    return createV3Error(
      requestId,
      error.status,
      error.code.toUpperCase(),
      retryable,
      retryable ? 1000 : undefined
    );
  }
  // Unknown server failures are not proof that a device request is invalid.
  // Mark them retryable so a transient dependency failure cannot permanently
  // strand note-pack convergence behind one generic 500 response.
  return createV3Error(
    requestId || requestIdFromUnknown(null),
    500,
    'NOTE_STUDY_FAILED',
    true,
    5000
  );
}
