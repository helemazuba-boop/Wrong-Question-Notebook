import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInternalRequest } from '@/lib/internal-request-auth';

const mocks = vi.hoisted(() => ({
  annotateProblemMarks: vi.fn(),
  serviceClient: { rpc: vi.fn() },
}));

vi.mock('@/lib/problem-marks/annotate', () => ({
  annotateProblemMarks: mocks.annotateProblemMarks,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => mocks.serviceClient,
}));

import { POST } from '@/app/api/internal/problem-marks/annotate/route';

const PROBLEM_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 's'.repeat(64);

function request(body: string, signed = true) {
  const timestamp = String(Date.now());
  return new Request('http://localhost/api/internal/problem-marks/annotate', {
    method: 'POST',
    headers: signed
      ? {
          'content-type': 'application/json',
          'x-wqn-timestamp': timestamp,
          'x-wqn-signature': signInternalRequest(SECRET, timestamp, body),
        }
      : { 'content-type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROBLEM_MARKING_SECRET = SECRET;
  mocks.annotateProblemMarks.mockResolvedValue({
    status: 'resolved',
    assignments: 1,
    unresolved: 0,
  });
});

describe('internal Problem Mark annotation route', () => {
  it('rejects unsigned requests before invoking the annotator', async () => {
    const response = await POST(
      request(JSON.stringify({ problem_id: PROBLEM_ID }), false)
    );
    expect(response.status).toBe(401);
    expect(mocks.annotateProblemMarks).not.toHaveBeenCalled();
  });

  it('validates the signed body before invoking the annotator', async () => {
    const response = await POST(request('{"problem_id":"not-a-uuid"}'));
    expect(response.status).toBe(400);
    expect(mocks.annotateProblemMarks).not.toHaveBeenCalled();
  });

  it('runs one explicit Problem through the service client', async () => {
    const response = await POST(
      request(JSON.stringify({ problem_id: PROBLEM_ID }))
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { status: 'resolved', assignments: 1, unresolved: 0 },
    });
    expect(mocks.annotateProblemMarks).toHaveBeenCalledWith(
      mocks.serviceClient,
      PROBLEM_ID
    );
  });
});
