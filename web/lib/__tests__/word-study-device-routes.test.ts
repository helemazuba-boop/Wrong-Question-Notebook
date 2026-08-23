import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as skip } from '@/app/api/esp32/v3/words/observations/skip/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { mockAuthenticate, mockFrom, mockRpc, mockStorageFrom } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
    mockStorageFrom: vi.fn(),
  })
);

vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: mockAuthenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
  }),
}));

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const WORD_ID = '33333333-3333-4333-8333-333333333333';
const OBS_ID = '44444444-4444-4444-8444-444444444444';

function wordRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/esp32/v3/words/observations/skip', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-word-study',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-request-id': String(body.request_id ?? 'req_missing'),
      'x-wqn-protocol': '3',
    },
    body: JSON.stringify(body),
  });
}

function meta(requestId: string) {
  return {
    request_id: requestId,
    boot_id: 'boot_word_route_001',
    firmware_version: '0.1.0-test',
    capabilities: ['word.study.v1'],
  };
}

function skipResult() {
  return {
    observation_id: OBS_ID,
    session_id: SESSION_ID,
    sequence: 0,
    item_id: WORD_ID,
    action: 'skipped',
    progress: null,
    projection_applied: false,
    replayed: false,
  };
}

beforeEach(() => {
  _resetRateLimitStore();
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({
    userId: USER_ID,
    deviceId: DEVICE_ID,
    hardwareId: 'AA:BB:CC:DD:EE:FF',
    configRevision: 0,
    syncCursor: 0,
  });
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('esp32/v3/words observation skip route', () => {
  it('accepts a minimal tombstone without action/mode/occurred_at', async () => {
    mockRpc.mockResolvedValueOnce({ data: skipResult(), error: null });
    const res = await skip(
      wordRequest({
        ...meta('req_word_route_skip1'),
        session_id: SESSION_ID,
        sequence: 0,
        item_id: WORD_ID,
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ action: 'skipped' });
    expect(mockRpc).toHaveBeenCalledWith(
      'skip_study_observation_v1',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_device_id: DEVICE_ID,
        p_action: null,
        p_mode: null,
        p_occurred_at: null,
      })
    );
  });

  it('forwards placeholder tombstone values unchanged', async () => {
    mockRpc.mockResolvedValueOnce({ data: skipResult(), error: null });
    const res = await skip(
      wordRequest({
        ...meta('req_word_route_skip2'),
        session_id: SESSION_ID,
        sequence: 0,
        item_id: WORD_ID,
        action: 'unknown',
        mode: 'random',
        occurred_at: '2026-07-20T03:20:00.000Z',
      })
    );
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'skip_study_observation_v1',
      expect.objectContaining({
        p_action: 'unknown',
        p_mode: 'random',
        p_occurred_at: '2026-07-20T03:20:00.000Z',
      })
    );
  });

  it('maps a sequence-gap RPC error to a retryable 409 envelope', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'STUDY_SEQUENCE_GAP' },
    });
    const res = await skip(
      wordRequest({
        ...meta('req_word_route_gap01'),
        session_id: SESSION_ID,
        sequence: 0,
        item_id: WORD_ID,
      })
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatchObject({ code: 'SEQUENCE_GAP', retryable: true });
  });

  it('maps INVALID_STUDY_OBSERVATION to a non-retryable 400', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_STUDY_OBSERVATION' },
    });
    const res = await skip(
      wordRequest({
        ...meta('req_word_route_inv01'),
        session_id: SESSION_ID,
        sequence: 0,
        item_id: WORD_ID,
      })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(body.error.retryable).toBeFalsy();
  });
});
