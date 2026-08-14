import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as bootstrap } from '@/app/api/esp32/v3/bootstrap/route';
import { POST as sync } from '@/app/api/esp32/v3/sync/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const {
  mockAuthenticate,
  mockLoadReplay,
  mockStoreResponse,
  mockFingerprint,
  mockFrom,
  mockRpc,
} = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockLoadReplay: vi.fn(),
  mockStoreResponse: vi.fn(),
  mockFingerprint: vi.fn(() => 'fingerprint'),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: mockAuthenticate,
  fingerprintDeviceControlRequest: mockFingerprint,
  loadDeviceControlReplay: mockLoadReplay,
  storeDeviceControlResponse: mockStoreResponse,
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DUE_PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
let deviceUpdateValue: unknown;

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-device-control-v3',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-protocol': '3',
      'x-wqn-request-id': String(body.request_id),
    },
    body: JSON.stringify(body),
  });
}

function malformedRequest(path: string, requestId: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-device-control-v3',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-protocol': '3',
      'x-wqn-request-id': requestId,
    },
    body: '{',
  });
}

function metadata(requestId: string) {
  return {
    request_id: requestId,
    boot_id: 'boot_control_route_0001',
    firmware_version: '0.1.0-test',
    capabilities: ['display.epd', 'sync.v3'],
    config_revision: 0,
    sync_cursor: 0,
  };
}

function queryBuilder(table: string) {
  let selected = '';
  let countOnly = false;
  let updateValue: unknown;
  const chain: Record<string, unknown> = {};
  const fluent = vi.fn(() => chain);
  chain.select = vi.fn((columns: string, options?: { head?: boolean }) => {
    selected = columns;
    countOnly = options?.head === true;
    return chain;
  });
  chain.eq = fluent;
  chain.lte = fluent;
  chain.or = fluent;
  chain.order = fluent;
  chain.limit = fluent;
  chain.update = vi.fn(value => {
    updateValue = value;
    if (table === 'esp32_devices') deviceUpdateValue = value;
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => {
    const revisions: Record<string, number> = {
      problems: 7,
      todos: 6,
      word_decks: 8,
      word_packs: 9,
    };
    return { data: { revision: revisions[table] ?? 0 }, error: null };
  });
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown
  ) => {
    try {
      if (table === 'esp32_devices' && updateValue !== undefined) {
        return Promise.resolve(
          resolve({ data: null, error: null, updateValue })
        );
      }
      if (table === 'review_schedule') {
        return Promise.resolve(
          resolve({ data: [{ problem_id: DUE_PROBLEM_ID }], error: null })
        );
      }
      if (table === 'todos' && selected === 'id' && countOnly) {
        return Promise.resolve(resolve({ data: null, count: 2, error: null }));
      }
      if (table === 'word_progress' && countOnly) {
        return Promise.resolve(resolve({ data: null, count: 5, error: null }));
      }
      return Promise.resolve(resolve({ data: null, error: null }));
    } catch (error) {
      return Promise.resolve(reject(error));
    }
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
  mockAuthenticate.mockResolvedValue({
    userId: USER_ID,
    deviceId: DEVICE_ID,
    hardwareId: 'AA:BB:CC:DD:EE:FF',
    configRevision: 4,
    syncCursor: 3,
    autoSyncIntervalMinutes: 60,
  });
  deviceUpdateValue = undefined;
  mockLoadReplay.mockResolvedValue({ kind: 'miss' });
  mockStoreResponse.mockResolvedValue({ kind: 'stored' });
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockFrom.mockImplementation((table: string) => queryBuilder(table));
});

describe('device-control v3 authenticated routes', () => {
  it('acknowledges the sealed claim and stores a replayable bootstrap response', async () => {
    const response = await bootstrap(
      request('/api/esp32/v3/bootstrap', metadata('req_bootstrap_0001'))
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      device_id: DEVICE_ID,
      config_revision: 4,
      sync_cursor: 3,
      media_protocols: {
        ai_sse: 'v2-streaming',
        flash: 'wqn-flash-v2',
      },
    });
    expect(mockRpc).toHaveBeenCalledWith('consume_device_claim_v3', {
      p_device_id: DEVICE_ID,
    });
    expect(mockStoreResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        requestId: 'req_bootstrap_0001',
        endpoint: 'bootstrap',
        status: 200,
        acknowledgedSyncCursor: 3,
        lastSyncAt: null,
      })
    );
  });

  it('returns the first bootstrap result for an identical request id', async () => {
    const replayBody = {
      ok: true,
      request_id: 'req_bootstrap_0001',
      server_time_ms: 1784426400000,
      data: {
        device_id: DEVICE_ID,
        config_revision: 4,
        sync_cursor: 3,
        media_protocols: { ai_sse: 'v2-streaming', flash: 'wqn-flash-v2' },
      },
    };
    mockLoadReplay.mockResolvedValue({
      kind: 'replay',
      response: NextResponse.json(replayBody),
    });

    const response = await bootstrap(
      request('/api/esp32/v3/bootstrap', metadata('req_bootstrap_0001'))
    );

    expect(await response.json()).toEqual(replayBody);
    expect(mockStoreResponse).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('stores the exact first result while advancing only the device-acknowledged cursor', async () => {
    const response = await sync(
      request('/api/esp32/v3/sync', {
        ...metadata('req_sync_000000001'),
        limit: 20,
        configuration: { auto_sync_interval_minutes: 15 },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.sync_cursor).toBe(9);
    expect(body.data.configuration).toEqual({
      auto_sync_interval_minutes: 15,
    });
    expect(deviceUpdateValue).toEqual({ auto_sync_interval_minutes: 15 });
    expect(body.data.summaries).toEqual({
      due_problem_ids: [DUE_PROBLEM_ID],
      todo_count: 2,
      word_due_count: 5,
    });
    expect(mockStoreResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        requestId: 'req_sync_000000001',
        endpoint: 'sync',
        status: 200,
        acknowledgedSyncCursor: 3,
      })
    );
  });

  it('echoes the stored cadence for older firmware that omits configuration', async () => {
    const response = await sync(
      request('/api/esp32/v3/sync', {
        ...metadata('req_sync_legacy_0001'),
        limit: 20,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.configuration).toEqual({
      auto_sync_interval_minutes: 60,
    });
    expect(deviceUpdateValue).toBeUndefined();
  });

  it('does not touch control state when authentication returns 401', async () => {
    mockAuthenticate.mockResolvedValue(
      NextResponse.json(
        {
          ok: false,
          request_id: 'req_sync_000000001',
          error: { code: 'UNAUTHORIZED', retryable: false },
        },
        { status: 401 }
      )
    );

    const response = await sync(
      request('/api/esp32/v3/sync', {
        ...metadata('req_sync_000000001'),
        limit: 20,
      })
    );

    expect(response.status).toBe(401);
    expect(mockLoadReplay).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockStoreResponse).not.toHaveBeenCalled();
  });

  it('authenticates before parsing a malformed body', async () => {
    mockAuthenticate.mockResolvedValue(
      NextResponse.json(
        {
          ok: false,
          request_id: 'req_sync_malformed',
          error: { code: 'UNAUTHORIZED', retryable: false },
        },
        { status: 401 }
      )
    );

    const response = await sync(
      malformedRequest('/api/esp32/v3/sync', 'req_sync_malformed')
    );

    expect(response.status).toBe(401);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
