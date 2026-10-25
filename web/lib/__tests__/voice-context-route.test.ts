import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/esp32/ai/context/route';
const { load, from, maybeSingle, eq } = vi.hoisted(() => ({
  load: vi.fn(),
  from: vi.fn(),
  maybeSingle: vi.fn(),
  eq: vi.fn(),
}));
vi.mock('@/lib/ai-tools/voice-context-server', () => ({
  loadVoiceContext: load,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from }),
}));
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  secret = 'context-test-secret-with-at-least-32-characters';
function request(body: unknown, auth = true, badSignature = false) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body),
    timestamp = Date.now().toString();
  return new NextRequest('https://wqn.test/api/esp32/ai/context', {
    method: 'POST',
    headers: {
      authorization: auth ? `Bearer ${secret}` : 'Bearer unrelated',
      'x-wqn-internal-timestamp': timestamp,
      'x-wqn-internal-signature': badSignature
        ? '0'.repeat(64)
        : createHmac('sha256', secret)
            .update(timestamp)
            .update('\n')
            .update(raw)
            .digest('hex'),
    },
    body: raw,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WQN_REALTIME_PROXY_SECRET', secret);
  vi.stubEnv('WQN_INTERNAL_API_ALLOWED_HOST', '');
  const q: any = { select: () => q, eq, maybeSingle };
  eq.mockReturnValue(q);
  from.mockReturnValue(q);
  maybeSingle.mockResolvedValue({ data: { id: device }, error: null });
  load.mockResolvedValue({
    now: '2026-10-14T00:00:00Z',
    timezone: 'Asia/Shanghai',
    notebooks: [],
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('internal device voice context endpoint', () => {
  it('requires the internal secret and a body-bound HMAC', async () => {
    expect(
      (await POST(request({ user_id: user, device_id: device }, false))).status
    ).toBe(401);
    expect(
      (await POST(request({ user_id: user, device_id: device }, true, true)))
        .status
    ).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });
  it('verifies user/device ownership before returning private notebook IDs', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(
      (await POST(request({ user_id: user, device_id: device }))).status
    ).toBe(401);
    expect(eq).toHaveBeenCalledWith('user_id', user);
    expect(eq).toHaveBeenCalledWith('id', device);
    expect(load).not.toHaveBeenCalled();
  });
  it('returns an uncached server context with the same turn anchor', async () => {
    const anchor = '2026-10-14T00:00:00Z';
    const response = await POST(
      request({ user_id: user, device_id: device, anchor_at: anchor })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user }),
      anchor
    );
    expect(JSON.stringify(await response.json())).not.toContain(secret);
  });
  it('accepts a persisted seeded user ID after signature and ownership checks', async () => {
    const seededUser = '00000000-0000-0000-0000-000000000002';
    const response = await POST(
      request({ user_id: seededUser, device_id: device })
    );
    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('user_id', seededUser);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ userId: seededUser }),
      undefined
    );
  });
  it('still rejects seeded identities with invalid signatures or ownership', async () => {
    const input = {
      user_id: '00000000-0000-0000-0000-000000000002',
      device_id: device,
    };
    expect((await POST(request(input, true, true))).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await POST(request(input))).status).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });
  it('keeps the disabled-account gate for a seeded identity', async () => {
    load.mockRejectedValue(new Error('Account disabled'));
    expect(
      (
        await POST(
          request({
            user_id: '00000000-0000-0000-0000-000000000002',
            device_id: device,
          })
        )
      ).status
    ).toBe(403);
  });
  it('rejects malformed user IDs before querying ownership', async () => {
    expect(
      (await POST(request({ user_id: 'not-an-id', device_id: device }))).status
    ).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects malformed payload and client-supplied permission snapshots', async () => {
    expect((await POST(request('bad-json'))).status).toBe(400);
    expect(
      (
        await POST(
          request({
            user_id: user,
            device_id: device,
            notebooks: [{ id: 'forged' }],
          })
        )
      ).status
    ).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
  it('does not turn a disabled account into device credential revocation', async () => {
    load.mockRejectedValue(new Error('Account disabled'));
    expect(
      (await POST(request({ user_id: user, device_id: device }))).status
    ).toBe(403);
  });
});
