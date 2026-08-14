import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  unauthorised: vi.fn(),
  createServiceClient: vi.fn(),
  recordRating: vi.fn(),
  correctRating: vi.fn(),
  runProjectionBatch: vi.fn(),
  after: vi.fn(),
}));

vi.mock('next/server', async importOriginal => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: mocks.unauthorised,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/problem-review-service', () => ({
  recordWebProblemReviewRating: mocks.recordRating,
  correctWebProblemReviewRating: mocks.correctRating,
}));
vi.mock('@/lib/fsrs/projector', () => ({
  runProjectionBatch: mocks.runProjectionBatch,
}));

import { PATCH, POST } from '@/app/api/problem-reviews/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OCCURRENCE_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const ownerSupabase = { from: vi.fn() };
const serviceSupabase = { rpc: vi.fn() };

function request(method: 'POST' | 'PATCH', body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/problem-reviews', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: ownerSupabase,
  });
  mocks.createServiceClient.mockReturnValue(serviceSupabase);
  mocks.recordRating.mockResolvedValue({
    event_id: EVENT_ID,
    review_occurrence_id: OCCURRENCE_ID,
  });
  mocks.correctRating.mockResolvedValue({
    event_id: EVENT_ID,
    review_occurrence_id: OCCURRENCE_ID,
  });
});

describe('problem Review Rating route', () => {
  it('accepts only human Rating identity and delegates evidence loading to the service', async () => {
    const response = await POST(
      request('POST', {
        attempt_id: ATTEMPT_ID,
        rating: 'Hard',
        review_occurrence_id: OCCURRENCE_ID,
        request_id: 'web-review-request-0001',
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.recordRating).toHaveBeenCalledWith({
      ownerSupabase,
      serviceSupabase,
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
      rating: 'Hard',
      reviewOccurrenceId: OCCURRENCE_ID,
      requestId: 'web-review-request-0001',
    });
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it('rejects browser-provided machine evidence and Review time', async () => {
    const response = await POST(
      request('POST', {
        attempt_id: ATTEMPT_ID,
        rating: 'Hard',
        review_occurrence_id: OCCURRENCE_ID,
        request_id: 'web-review-request-0001',
        machine_correctness_snapshot: true,
        reviewed_at: '2026-08-09T08:00:00.000Z',
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.recordRating).not.toHaveBeenCalled();
  });

  it('returns a validation response for malformed JSON', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/problem-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.recordRating).not.toHaveBeenCalled();
  });

  it('corrects the terminal Event without accepting a second Attempt', async () => {
    const response = await PATCH(
      request('PATCH', {
        rating: 'Good',
        review_occurrence_id: OCCURRENCE_ID,
        terminal_event_id: EVENT_ID,
        request_id: 'web-review-correction-01',
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.correctRating).toHaveBeenCalledWith({
      ownerSupabase,
      serviceSupabase,
      userId: USER_ID,
      rating: 'Good',
      reviewOccurrenceId: OCCURRENCE_ID,
      terminalEventId: EVENT_ID,
      requestId: 'web-review-correction-01',
    });
  });
});
