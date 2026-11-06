import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/esp32/v3/study/observations/receipts/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';
import { readOutboxReceipts } from '../outbox-reconciliation-service';
import {
  OUTBOX_RECEIPTS_MAX_BYTES,
  OUTBOX_RECEIPTS_RPC_TIMEOUT_MS,
  outboxReceiptDataSchema,
  outboxReceiptRequestSchema,
  type OutboxReceiptRequest,
} from '../outbox-reconciliation-v1';

const { authenticate, rpc, abort } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  rpc: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: authenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const SESSION = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';
const ORIGINAL = 'receipt_original_00001';

function query(): OutboxReceiptRequest {
  return {
    request_id: 'receipt_query_0000001',
    boot_id: 'boot_receipt_00001',
    firmware_version: '0.1.0-test',
    capabilities: ['outbox.receipts.v1'],
    contract: 'outbox-reconciliation-v1',
    domain: 'word',
    session_id: SESSION,
    request_ids: [ORIGINAL, 'receipt_missing_00001', 'receipt_conflict_0001'],
  };
}

function canonical() {
  return {
    contract: 'outbox-reconciliation-v1',
    read_at: '2026-11-06T09:00:00+00:00',
    actor: { user_id: USER, device_id: DEVICE },
    session: {
      session_id: SESSION,
      domain: 'word',
      mode: 'sequential',
      status: 'abandoned',
      next_sequence: 8,
      expires_at: '2026-11-01T00:00:00+00:00',
    },
    receipts: [
      {
        request_id: ORIGINAL,
        state: 'found',
        observation: {
          observation_id: '44444444-4444-4444-8444-444444444444',
          request_id: ORIGINAL,
          session_id: SESSION,
          sequence: 7,
          item_id: '33333333-3333-4333-8333-333333333333',
          action: 'shown',
          mode: 'sequential',
          occurred_at: '2026-10-27T01:00:00+00:00',
          created_at: '2026-10-27T01:00:01+00:00',
        },
      },
      {
        request_id: 'receipt_missing_00001',
        state: 'not_found',
        observation: null,
      },
      {
        request_id: 'receipt_conflict_0001',
        state: 'conflict',
        observation: null,
      },
    ],
    repair_authorized: false,
  };
}

function request(
  body: unknown = query(),
  headers: Record<string, string> = {}
) {
  return new NextRequest(
    'http://localhost/api/esp32/v3/study/observations/receipts',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(64)}`,
        'content-type': 'application/json',
        'user-agent': 'vitest-receipts',
        'x-forwarded-for': '127.0.0.1',
        'x-wqn-protocol': '3',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  _resetRateLimitStore();
  authenticate.mockResolvedValue({ userId: USER, deviceId: DEVICE });
  rpc.mockReturnValue({ abortSignal: abort });
  abort.mockResolvedValue({ data: canonical(), error: null });
});

describe('read-only outbox receipt route', () => {
  it('binds the canonical lookup to authenticated actor and original request IDs', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.data).toEqual(canonical());
    expect(envelope.request_id).toBe(query().request_id);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      'lookup_device_outbox_receipts_v1',
      {
        p_user_id: USER,
        p_device_id: DEVICE,
        p_domain: 'word',
        p_session_id: SESSION,
        p_request_ids: query().request_ids,
      }
    );
    expect(abort).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('uses a bounded RPC transport timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await POST(request());
    expect(timeout).toHaveBeenCalledWith(OUTBOX_RECEIPTS_RPC_TIMEOUT_MS);
  });

  it('accepts historical PostgreSQL/native UUID text including the default user', async () => {
    const legacyUser = '00000000-0000-0000-0000-000000000001';
    const legacySession = '11111111-1111-1111-1111-111111111111';
    const data = canonical();
    data.actor.user_id = legacyUser;
    data.session.session_id = legacySession;
    data.receipts[0].observation!.session_id = legacySession;
    data.receipts[0].observation!.item_id =
      '22222222-2222-2222-2222-222222222222';
    authenticate.mockResolvedValueOnce({
      userId: legacyUser,
      deviceId: DEVICE,
    });
    abort.mockResolvedValueOnce({ data, error: null });
    expect(
      (await POST(request({ ...query(), session_id: legacySession }))).status
    ).toBe(200);
  });

  it('compares UUID identity independently of hex letter case', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const data = canonical();
    data.session.session_id = sessionId;
    data.receipts[0].observation!.session_id = sessionId;
    abort.mockResolvedValueOnce({ data, error: null });
    expect(
      (await POST(request({ ...query(), session_id: sessionId.toUpperCase() })))
        .status
    ).toBe(200);
  });

  it('retains an expired/retired session receipt and never infers missing IDs from next_sequence', async () => {
    const res = await POST(request());
    const { data } = await res.json();
    expect(data.session.status).toBe('abandoned');
    expect(data.session.next_sequence).toBe(8);
    expect(data.receipts[1]).toEqual({
      request_id: query().request_ids[1],
      state: 'not_found',
      observation: null,
    });
    expect(data.repair_authorized).toBe(false);
  });

  it('accepts Note facts under their own action/mode contract', async () => {
    const body = { ...query(), domain: 'note' };
    const data = canonical();
    data.session.domain = 'note';
    data.session.mode = 'recent';
    data.receipts[0].observation!.action = 'opened';
    data.receipts[0].observation!.mode = 'recent';
    abort.mockResolvedValueOnce({ data, error: null });
    expect((await POST(request(body))).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_domain).toBe('note');
  });

  it('rejects protocol drift before authentication or database access', async () => {
    expect(
      (await POST(request(query(), { 'x-wqn-protocol': '2' }))).status
    ).toBe(426);
    expect(authenticate).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])(
    'preserves authentication failure %s without querying facts',
    async status => {
      authenticate.mockResolvedValueOnce(
        NextResponse.json({ ok: false }, { status })
      );
      expect((await POST(request())).status).toBe(status);
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it('refuses web/null device actors', async () => {
    authenticate.mockResolvedValueOnce({ userId: USER, deviceId: null });
    expect((await POST(request())).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { user_id: OTHER },
    { device_id: OTHER },
    { repair_authorized: true },
    { domain: 'problem' },
    { session_id: 'not-a-uuid' },
    { session_id: SESSION + '\n' },
    { request_ids: [] },
    { request_ids: [ORIGINAL, ORIGINAL] },
    { request_ids: ['unsafe/request_00001'] },
    {
      request_ids: Array.from(
        { length: 65 },
        (_, i) => `receipt_over_limit_${String(i).padStart(3, '0')}`
      ),
    },
  ])('rejects unsupported input without RPC: %j', async extra => {
    expect((await POST(request({ ...query(), ...extra }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('counts streamed bytes even with a lying content-length', async () => {
    expect(
      (
        await POST(
          request(' '.repeat(OUTBOX_RECEIPTS_MAX_BYTES + 1), {
            'content-length': '1',
          })
        )
      ).status
    ).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    expect((await POST(request('{'))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not distinguish unowned, wrong-domain and missing sessions', async () => {
    abort.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(request());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('OUTBOX_SESSION_UNAVAILABLE');
  });

  it.each(['error', 'throw'])(
    'reports RPC %s as unavailable rather than absent',
    async failure => {
      if (failure === 'error')
        abort.mockResolvedValueOnce({
          data: null,
          error: { code: '57014', message: 'timeout' },
        });
      else abort.mockRejectedValueOnce(new Error('transport timeout'));
      const res = await POST(request());
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatchObject({
        code: 'OUTBOX_RECEIPTS_UNAVAILABLE',
        retryable: true,
      });
    }
  );

  it.each([
    'actor',
    'device',
    'session',
    'domain',
    'order',
    'truncated',
    'request-id',
    'item-session',
    'item-mode',
    'item-action',
    'repair',
    'counter',
  ])('rejects an invalid or misbound stored reply: %s', async field => {
    const data = canonical();
    switch (field) {
      case 'actor':
        data.actor.user_id = OTHER;
        break;
      case 'device':
        data.actor.device_id = OTHER;
        break;
      case 'session':
        data.session.session_id = OTHER;
        break;
      case 'domain':
        data.session.domain = 'note';
        break;
      case 'order':
        data.receipts.reverse();
        break;
      case 'truncated':
        data.receipts.pop();
        break;
      case 'request-id':
        data.receipts[0].observation!.request_id = 'receipt_wrong_id_0001';
        break;
      case 'item-session':
        data.receipts[0].observation!.session_id = OTHER;
        break;
      case 'item-mode':
        data.receipts[0].observation!.mode = 'random';
        break;
      case 'item-action':
        data.receipts[0].observation!.action = 'opened';
        break;
      case 'repair':
        Object.assign(data, { repair_authorized: true });
        break;
      case 'counter':
        data.session.next_sequence = Number.MAX_SAFE_INTEGER + 1;
        break;
    }
    abort.mockResolvedValueOnce({ data, error: null });
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('OUTBOX_RECEIPTS_UNAVAILABLE');
  });

  it('does not accept conflicting observation payloads in a non-found receipt', () => {
    const data = canonical();
    data.receipts[0].state = 'conflict';
    expect(outboxReceiptDataSchema.safeParse(data).success).toBe(false);
  });

  it('validates the request again at the service boundary', async () => {
    await expect(
      readOutboxReceipts({ rpc } as never, USER, DEVICE, {
        ...query(),
        user_id: OTHER,
      } as OutboxReceiptRequest)
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts exactly 64 unique original request IDs', () => {
    expect(
      outboxReceiptRequestSchema.safeParse({
        ...query(),
        request_ids: Array.from(
          { length: 64 },
          (_, i) => `receipt_max_items_${String(i).padStart(3, '0')}`
        ),
      }).success
    ).toBe(true);
  });
});
