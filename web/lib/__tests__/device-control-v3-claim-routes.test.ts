import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as pollClaim } from '@/app/api/esp32/v3/claim/poll/route';
import { POST as startClaim } from '@/app/api/esp32/v3/claim/start/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const mockFrom = vi.fn();

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));

const DEVICE_PUBLIC_KEY =
  'BBDnMwKxCsA1KvHzI0dBZKXH8nHx3oWyBzF9owKtZcV2e3ixYp0yb6M8SQrtQmReGkE_bjHgJxQkj7nJlFJvVn0';
const CLAIM_ID = '11111111-1111-4111-8111-111111111111';

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-protocol': '3',
      'x-wqn-request-id': String(body.request_id),
    },
    body: JSON.stringify(body),
  });
}

function claimMetadata(requestId: string) {
  return {
    request_id: requestId,
    boot_id: 'boot_claim_route_0001',
    firmware_version: '0.1.0-test',
    capabilities: ['display.epd', 'sync.v3'],
  };
}

function builder(input: {
  maybeSingle: unknown;
  single?: unknown;
  onInsert?: (value: unknown) => void;
  onUpdate?: (value: unknown) => void;
}) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.insert = vi.fn(value => {
    input.onInsert?.(value);
    return chain;
  });
  chain.update = vi.fn(value => {
    input.onUpdate?.(value);
    return chain;
  });
  chain.maybeSingle = vi.fn().mockResolvedValue(input.maybeSingle);
  chain.single = vi
    .fn()
    .mockResolvedValue(input.single ?? { data: null, error: null });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitStore();
});

describe('device-control v3 claim routes', () => {
  it('creates a claim without accepting device credentials from the client', async () => {
    let inserted: unknown;
    const chain = builder({
      maybeSingle: { data: null, error: null },
      single: { data: { id: CLAIM_ID }, error: null },
      onInsert: value => {
        inserted = value;
      },
    });
    mockFrom.mockReturnValue(chain);

    const response = await startClaim(
      request('/api/esp32/v3/claim/start', {
        ...claimMetadata('req_claim_start_0001'),
        hardware_id: 'AA:BB:CC:DD:EE:FF',
        device_public_key: DEVICE_PUBLIC_KEY,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.claim_id).toBe(CLAIM_ID);
    expect(body.data.display_code).toMatch(/^[0-9]{8}$/);
    expect(inserted).toMatchObject({
      hardware_id: 'AA:BB:CC:DD:EE:FF',
      boot_id: 'boot_claim_route_0001',
      request_id: 'req_claim_start_0001',
      device_public_key: DEVICE_PUBLIC_KEY,
    });
    expect(inserted).not.toHaveProperty('access_token');
    expect(inserted).not.toHaveProperty('user_id');
  });

  it('replays the same pending claim for the same idempotency key', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const chain = builder({
      maybeSingle: {
        data: {
          id: CLAIM_ID,
          display_code: '31415926',
          expires_at: expiresAt,
          poll_interval_ms: 3000,
          status: 'pending',
          device_public_key: DEVICE_PUBLIC_KEY,
        },
        error: null,
      },
    });
    mockFrom.mockReturnValue(chain);

    const response = await startClaim(
      request('/api/esp32/v3/claim/start', {
        ...claimMetadata('req_claim_start_0001'),
        hardware_id: 'AA:BB:CC:DD:EE:FF',
        device_public_key: DEVICE_PUBLIC_KEY,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      claim_id: CLAIM_ID,
      display_code: '31415926',
      poll_interval_ms: 3000,
    });
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it('returns the same sealed credential while an approved claim is unconsumed', async () => {
    const sealedCredential = {
      server_public_key: DEVICE_PUBLIC_KEY,
      salt: 'ERERERERQRGBEREREREREQ',
      iv: 'IiIiIiIiIiIiIiIi',
      ciphertext:
        'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz',
    };
    const chain = builder({
      maybeSingle: {
        data: {
          status: 'approved',
          boot_id: 'boot_claim_route_0001',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          poll_interval_ms: 3000,
          sealed_credential: sealedCredential,
        },
        error: null,
      },
    });
    mockFrom.mockReturnValue(chain);
    const body = {
      ...claimMetadata('req_claim_poll_0001'),
      claim_id: CLAIM_ID,
    };

    const first = await pollClaim(request('/api/esp32/v3/claim/poll', body));
    const second = await pollClaim(
      request('/api/esp32/v3/claim/poll', {
        ...body,
        request_id: 'req_claim_poll_0002',
      })
    );

    expect(first.status).toBe(200);
    expect((await first.json()).data.sealed_credential).toEqual(
      sealedCredential
    );
    expect(second.status).toBe(200);
    expect((await second.json()).data.sealed_credential).toEqual(
      sealedCredential
    );
  });

  it('does not disclose a claim to a different boot id', async () => {
    const chain = builder({
      maybeSingle: {
        data: {
          status: 'pending',
          boot_id: 'boot_claim_route_other',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          poll_interval_ms: 3000,
          sealed_credential: null,
        },
        error: null,
      },
    });
    mockFrom.mockReturnValue(chain);

    const response = await pollClaim(
      request('/api/esp32/v3/claim/poll', {
        ...claimMetadata('req_claim_poll_0001'),
        claim_id: CLAIM_ID,
      })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'CLAIM_NOT_FOUND', retryable: false },
    });
  });
});
