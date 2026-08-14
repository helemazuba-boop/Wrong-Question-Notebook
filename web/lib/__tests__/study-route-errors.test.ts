import { describe, expect, it } from 'vitest';
import { DeviceContentArtifactError } from '@/lib/device-content-artifacts';
import { noteStudyErrorResponse } from '@/lib/note-study-route';
import { problemStudyErrorResponse } from '@/lib/problem-study-route';

const REQUEST_ID = 'req_study_route_error_0001';

describe('device study route error mapping', () => {
  it.each([
    ['note', noteStudyErrorResponse],
    ['problem', problemStudyErrorResponse],
  ])(
    'marks %s artifact storage failures retryable',
    async (_domain, mapper) => {
      const response = mapper(
        REQUEST_ID,
        new DeviceContentArtifactError(
          'artifact_storage_error',
          'storage temporarily unavailable',
          500
        )
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        request_id: REQUEST_ID,
        error: {
          code: 'ARTIFACT_STORAGE_ERROR',
          retryable: true,
          retry_after_ms: 1000,
        },
      });
    }
  );

  it.each([
    ['note', noteStudyErrorResponse, 'NOTE_STUDY_FAILED'],
    ['problem', problemStudyErrorResponse, 'PROBLEM_STUDY_FAILED'],
  ])(
    'keeps unknown %s server failures retryable',
    async (_domain, mapper, code) => {
      const response = mapper(REQUEST_ID, new Error('unexpected dependency'));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        request_id: REQUEST_ID,
        error: { code, retryable: true, retry_after_ms: 5000 },
      });
    }
  );

  it.each([
    ['note', noteStudyErrorResponse],
    ['problem', problemStudyErrorResponse],
  ])('does not retry invalid %s artifacts', async (_domain, mapper) => {
    const response = mapper(
      REQUEST_ID,
      new DeviceContentArtifactError(
        'invalid_artifact',
        'invalid immutable artifact hash',
        500
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARTIFACT', retryable: false },
    });
  });
});
