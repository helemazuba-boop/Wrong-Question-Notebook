import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/esp32/agent/sessions/[id]/run/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { rpc, claim, complete } = vi.hoisted(() => ({
  rpc: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: async () => ({
    userId: 'user-a',
    deviceId: 'device-a',
  }),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));
vi.mock('@/lib/opencode-agent-run-idempotency', () => ({
  claimAgentRunRequest: claim,
  completeAgentRunRequest: complete,
  fingerprintAgentRunRequest: () => 'fingerprint',
}));
const binding = {
  baseUrl: 'https://opencode.test',
  directory: '/work',
  model: 'a/main',
  fallbackModel: 'b/backup',
  fallbackEnabled: true,
  fallbackPolicy: {
    maxInputTokens: 100,
    maxOutputTokens: 10,
    maxTotalTokens: 500,
    maxProviderRequests: 3,
    maxSteps: 2,
    maxDurationMs: 60000,
    maxFallbacksPer24Hours: 3,
    maxUserTokensPer24Hours: 1000,
    cooldownMs: 600000,
    quotaGroups: { 'a/main': 'one', 'b/backup': 'two' },
  },
};
let pluginActive: boolean, primaryAvailable: boolean, rejectSubmit: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  session_id: 'ses_test',
  state: 'armed',
  request_count: 0,
  fallback_count: 0,
};
beforeEach(() => {
  _resetRateLimitStore();
  vi.clearAllMocks();
  pluginActive = true;
  primaryAvailable = true;
  rejectSubmit = false;
  vi.stubEnv(
    'WQN_OPENCODE_USER_BINDINGS_JSON',
    JSON.stringify({ 'user-a': binding })
  );
  vi.stubEnv('WQN_OPENCODE_CONTROL_SECRET', 'x'.repeat(40));
  claim.mockResolvedValue({ kind: 'claimed' });
  complete.mockResolvedValue(undefined);
  rpc.mockImplementation(async (_name, { p_action }: { p_action: string }) => ({
    data: p_action === 'arm' ? task : null,
    error: null,
  }));
  fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
    const p = input.pathname;
    if (p === '/api/plugin')
      return Response.json({
        data: [
          {
            id: 'wqn.agent-control.v1',
            state: { status: pluginActive ? 'active' : 'error' },
          },
        ],
      });
    if (p === '/api/session/active') return Response.json({ data: {} });
    if (p === '/api/model')
      return Response.json({
        data: [
          {
            providerID: 'a',
            id: 'main',
            enabled: primaryAvailable,
            capabilities: { tools: true },
          },
          {
            providerID: 'b',
            id: 'backup',
            enabled: true,
            capabilities: { tools: true },
          },
        ],
      });
    if (p === '/api/session/ses_test')
      return Response.json({
        data: {
          id: 'ses_test',
          model: { providerID: 'a', id: 'main', variant: 'default' },
        },
      });
    if (p === '/api/event')
      return new Response(
        'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_test"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    if (p.endsWith('/prompt')) {
      if (rejectSubmit)
        throw new Error('Network timeout after ambiguous admission');
      return Response.json({ data: { type: 'user', sessionID: 'ses_test' } });
    }
    if (p.endsWith('/model')) return Response.json({ data: {} });
    expect(init?.method ?? 'GET').toBe('GET');
    return Response.json({
      data:
        input.searchParams.get('parentID') === 'ses_test'
          ? []
          : [{ id: 'ses_test' }],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const run = () =>
  POST(
    new NextRequest('http://localhost/api/esp32/agent/sessions/ses_test/run', {
      method: 'POST',
      body: JSON.stringify({
        text: 'bounded task',
        confirmed: true,
        request_id: '0123456789abcdef',
      }),
    }),
    { params: Promise.resolve({ id: 'ses_test' }) }
  );
const prompts = () =>
  fetchMock.mock.calls.filter(([url]) => url.pathname.endsWith('/prompt'));
it('requires an active native controller before task admission', async () => {
  pluginActive = false;
  expect((await run()).status).toBe(503);
  expect(prompts()).toHaveLength(0);
  expect(rpc).not.toHaveBeenCalled();
});
it('submits exactly one deterministic admission and records completion', async () => {
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('status":"idle');
  expect(prompts()).toHaveLength(1);
  expect(JSON.parse(prompts()[0][1].body as string)).toMatchObject({
    id: expect.stringMatching(/^msg_wqn_/),
    metadata: { wqn_task_id: task.id },
  });
  expect(rpc).toHaveBeenCalledWith(
    'opencode_agent_control_v1',
    expect.objectContaining({
      p_action: 'finish',
      p_payload: { taskId: task.id, state: 'completed' },
    })
  );
});
it('charges preflight fallback once and switches before the sole prompt', async () => {
  primaryAvailable = false;
  await (await run()).text();
  expect(rpc).toHaveBeenCalledWith(
    'opencode_agent_control_v1',
    expect.objectContaining({
      p_action: 'fallback',
      p_payload: { taskId: task.id, reason: 'model_unavailable' },
    })
  );
  expect(
    fetchMock.mock.calls.find(
      ([url, init]) =>
        url.pathname.endsWith('/model') && init?.method === 'POST'
    )?.[1]?.body
  ).toBe(JSON.stringify({ model: { providerID: 'b', id: 'backup' } }));
  expect(prompts()).toHaveLength(1);
});
it('retains an ambiguous submit as unknown and does not resubmit', async () => {
  rejectSubmit = true;
  expect(await (await run()).text()).toContain('agent.error');
  expect(prompts()).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith(
    'opencode_agent_control_v1',
    expect.objectContaining({
      p_action: 'finish',
      p_payload: { taskId: task.id, state: 'unknown' },
    })
  );
});
