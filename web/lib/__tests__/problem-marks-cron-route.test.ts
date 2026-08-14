import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProblemMarkAnnotationBatch: vi.fn(),
}));

vi.mock('@/lib/problem-marks/worker', () => ({
  runProblemMarkAnnotationBatch: mocks.runProblemMarkAnnotationBatch,
}));

import { GET } from '@/app/api/cron/problem-marks-annotate/route';

const CRON_SECRET = 'test-cron-secret';

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/problem-marks-annotate', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  mocks.runProblemMarkAnnotationBatch.mockResolvedValue({
    claimed: 0,
    resolved: 0,
    unresolved: 0,
    failed: 0,
    skipped: 0,
    stoppedEarly: false,
  });
});

describe('cron problem-marks-annotate route', () => {
  it('rejects a missing or wrong bearer token without running the worker', async () => {
    for (const req of [request(), request('Bearer wrong')]) {
      const response = await GET(req);
      expect(response.status).toBe(401);
    }
    expect(mocks.runProblemMarkAnnotationBatch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request(`Bearer ${CRON_SECRET}`));
    expect(response.status).toBe(401);
    expect(mocks.runProblemMarkAnnotationBatch).not.toHaveBeenCalled();
  });

  it('runs the bounded batch when authorized', async () => {
    const response = await GET(request(`Bearer ${CRON_SECRET}`));
    expect(response.status).toBe(200);
    expect(mocks.runProblemMarkAnnotationBatch).toHaveBeenCalledWith({
      limit: 20,
      leaseSeconds: 180,
      concurrency: 2,
      deadlineMs: 240_000,
    });
    const body = await response.json();
    expect(body.data).toMatchObject({ claimed: 0, resolved: 0 });
  });

  it('surfaces a worker failure as a 500', async () => {
    mocks.runProblemMarkAnnotationBatch.mockRejectedValue(new Error('boom'));
    const response = await GET(request(`Bearer ${CRON_SECRET}`));
    expect(response.status).toBe(500);
  });
});
