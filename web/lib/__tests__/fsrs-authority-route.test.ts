import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInternalRequest } from '@/lib/internal-request-auth';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  applyAction: vi.fn(),
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/fsrs/authority-control', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/fsrs/authority-control')>();
  return { ...actual, applyFsrsAuthorityAction: mocks.applyAction };
});

import { POST } from '@/app/api/internal/problem-reviews/authority/route';
import { FsrsAuthorityControlError } from '@/lib/fsrs/authority-control';

const SECRET = 's'.repeat(64);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROBLEM_ID = '22222222-2222-4222-8222-222222222222';
const CUTOVER_ID = '33333333-3333-4333-8333-333333333333';

function request(body: unknown, signed = true) {
  const bodyText = JSON.stringify(body);
  const timestamp = String(Date.now());
  return new NextRequest(
    'http://localhost/api/internal/problem-reviews/authority',
    {
      method: 'POST',
      headers: signed
        ? {
            'content-type': 'application/json',
            'x-wqn-timestamp': timestamp,
            'x-wqn-signature': signInternalRequest(SECRET, timestamp, bodyText),
          }
        : { 'content-type': 'application/json' },
      body: bodyText,
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROBLEM_REVIEW_PROJECTION_SECRET = SECRET;
  mocks.createServiceClient.mockReturnValue({ rpc: vi.fn() });
});

describe('internal FSRS authority control route', () => {
  it('rejects unsigned requests before creating a service client', async () => {
    const response = await POST(
      request(
        { action: 'cancel', user_id: USER_ID, cutover_id: CUTOVER_ID },
        false
      )
    );
    expect(response.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('strictly validates and delegates a complete cutover expectation set', async () => {
    const input = {
      action: 'cutover' as const,
      user_id: USER_ID,
      expected_projections: [
        {
          problem_id: PROBLEM_ID,
          projection_revision: 4,
          timeline_fingerprint: 'a'.repeat(64),
        },
      ],
    };
    mocks.applyAction.mockResolvedValue({
      cutover_id: CUTOVER_ID,
      user_id: USER_ID,
      authority_mode: 'fsrs',
      problem_count: 1,
    });

    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(mocks.applyAction).toHaveBeenCalledWith(expect.anything(), input);
  });

  it('delegates cancellation and exposes only finite control errors', async () => {
    const input = {
      action: 'cancel' as const,
      user_id: USER_ID,
      cutover_id: CUTOVER_ID,
    };
    mocks.applyAction.mockRejectedValue(
      new FsrsAuthorityControlError('FSRS_CUTOVER_HAS_NEW_REVIEWS', 409)
    );

    const response = await POST(request(input));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'FSRS_CUTOVER_HAS_NEW_REVIEWS',
    });
  });

  it('rejects extra fields instead of widening the mutation surface', async () => {
    const response = await POST(
      request({
        action: 'cancel',
        user_id: USER_ID,
        cutover_id: CUTOVER_ID,
        force: true,
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.applyAction).not.toHaveBeenCalled();
  });
});
