import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as recordObservation } from '@/app/api/words/study/observations/route';
import { POST as skipObservation } from '@/app/api/words/study/observations/skip/route';

const { mockRequireUser, mockRpc } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mockRequireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: mockRpc }),
}));

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';

function request() {
  return new Request('http://localhost/api/words/study/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: 'webobservation_route_0001',
      session_id: SESSION_ID,
      sequence: 0,
      item_id: ITEM_ID,
      action: 'unknown',
      mode: 'random',
      occurred_at: '2026-08-01T04:00:00.000Z',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: {},
    error: null,
  });
});

describe('Web Word study route adapter', () => {
  it('records through the canonical RPC as the Web actor', async () => {
    mockRpc.mockResolvedValue({
      data: {
        observation_id: OBSERVATION_ID,
        session_id: SESSION_ID,
        sequence: 0,
        item_id: ITEM_ID,
        action: 'unknown',
        progress: {
          status: 'learning',
          due_at: '2026-08-01T04:00:00.000+00:00',
          reviewed_count: 1,
          known_count: 0,
          unknown_count: 1,
        },
        projection_applied: true,
        replayed: false,
      },
      error: null,
    });

    const response = await recordObservation(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      session_id: SESSION_ID,
      action: 'unknown',
      projection_applied: true,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'record_study_observation_v1',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_device_id: null,
        p_request_id: 'webobservation_route_0001',
        p_sequence: 0,
      })
    );
  });

  it('preserves retryability for a sequence gap', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'STUDY_SEQUENCE_GAP' },
    });

    const response = await recordObservation(request());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: 'SEQUENCE_GAP',
      retryable: true,
    });
  });

  it('writes a non-projecting skip tombstone for terminal item failures', async () => {
    mockRpc.mockResolvedValue({
      data: {
        observation_id: OBSERVATION_ID,
        session_id: SESSION_ID,
        sequence: 0,
        item_id: ITEM_ID,
        action: 'skipped',
        progress: null,
        projection_applied: false,
        replayed: false,
      },
      error: null,
    });
    const original = await request().json();
    const response = await skipObservation(
      new Request('http://localhost/api/words/study/observations/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...original, action: 'skipped' }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      action: 'skipped',
      projection_applied: false,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'skip_study_observation_v1',
      expect.objectContaining({
        p_device_id: null,
        p_sequence: 0,
      })
    );
  });
});
