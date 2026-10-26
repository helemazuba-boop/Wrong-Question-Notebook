import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/esp32/ai/execute-tool/route';
const { load, execute, build, maybeSingle } = vi.hoisted(() => ({
  load: vi.fn(),
  execute: vi.fn(),
  build: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock('@/lib/ai-tools/voice-context-server', () => ({
  loadVoiceContext: load,
}));
vi.mock('@/app/api/esp32/ai/transcribe-chat/v2-tools', () => ({
  buildAiToolExecutor: build,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => {
    const query: any = { select: () => query, eq: () => query, maybeSingle };
    return { from: () => query };
  },
}));
const secret = 'voice-test-secret-at-least-32-characters';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const payload = {
  request_id: 'tool_request_0001',
  user_id: user,
  device_id: device,
  tool_name: 'create_notebook_note',
  raw_args:
    '{"notebook_id":"private-notebook","title":"private title","content":"private content"}',
  anchor_at: '2026-10-21T00:00:00Z',
};
function request(body: unknown = payload, signature = true) {
  const raw = JSON.stringify(body),
    timestamp = Date.now().toString();
  return new NextRequest('http://app.test/api/esp32/ai/execute-tool', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'x-wqn-internal-timestamp': timestamp,
      'x-wqn-internal-signature': signature
        ? createHmac('sha256', secret)
            .update(timestamp)
            .update('\n')
            .update(raw)
            .digest('hex')
        : 'bad-signature',
    },
    body: raw,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WQN_REALTIME_PROXY_SECRET', secret);
  vi.stubEnv('WQN_INTERNAL_API_ALLOWED_HOST', '');
  maybeSingle.mockResolvedValue({ data: { id: device }, error: null });
  load.mockResolvedValue({
    now: payload.anchor_at,
    timezone: 'Asia/Shanghai',
    notebooks: [],
  });
  build.mockReturnValue(execute);
  execute.mockResolvedValue({
    ok: true,
    display: 'Note saved',
    data: { note: { id: user } },
    action: null,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('signed Flash tool endpoint', () => {
  it('rejects an invalid signature before accessing device data or tools', async () => {
    expect((await POST(request(payload, false))).status).toBe(401);
    expect(maybeSingle).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects an unbound user/device before constructing the executor', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await POST(request())).status).toBe(401);
    expect(build).not.toHaveBeenCalled();
  });
  it.each(['update_notebook_note', 'search_words'])(
    'rejects unexposed %s',
    async tool_name => {
      expect((await POST(request({ ...payload, tool_name }))).status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it('passes the signed identity and original turn clock, and preserves the receipt envelope', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user }),
      payload.anchor_at
    );
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user,
        deviceId: device,
        requestId: payload.request_id,
        timeContext: expect.objectContaining({ now: payload.anchor_at }),
      })
    );
    expect(execute).toHaveBeenCalledWith(payload.tool_name, payload.raw_args, {
      callId: payload.request_id,
      requestId: payload.request_id,
    });
    expect(await response.json()).toMatchObject({
      success: true,
      result: { ok: true, data: { note: { id: user } } },
    });
  });
  it('preserves business failure codes even when HTTP succeeds', async () => {
    execute.mockResolvedValue({
      ok: false,
      display: 'Writing note failed',
      error: { code: 'notebook_permission_denied', message: '授权不足' },
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      result: { ok: false, error: { code: 'notebook_permission_denied' } },
    });
  });
  it('accepts a bound seeded user and preserves the original operation ID', async () => {
    const seededUser = '00000000-0000-0000-0000-000000000002';
    const response = await POST(request({ ...payload, user_id: seededUser }));
    expect(response.status).toBe(200);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: seededUser,
        requestId: payload.request_id,
      })
    );
    expect(execute).toHaveBeenCalledWith(payload.tool_name, payload.raw_args, {
      callId: payload.request_id,
      requestId: payload.request_id,
    });
  });
  it('still denies an unbound seeded identity before constructing tools', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await POST(
      request({ ...payload, user_id: '00000000-0000-0000-0000-000000000002' })
    );
    expect(response.status).toBe(401);
    expect(build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
