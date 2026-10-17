import { describe, expect, it, vi } from 'vitest';
import {
  installControl,
  createControlClient,
  classifyProviderFailure,
} from '../../server/opencode-control/index.mjs';
import { classifyOpenCodeProviderFailure } from '../opencode-agent-policy';

const primary = 'a/main',
  fallback = 'b/backup';
async function fixture() {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const task = {
    id: 'task-1',
    session_id: 'ses_root',
    state: 'armed',
    deadline: new Date(Date.now() + 60000).toISOString(),
    actual_model: null as string | null,
    fallback_count: 0,
    policy: { primary, fallback, limits: { maxOutputTokens: 32 } },
  };
  const control = vi.fn(async (action: string, payload: any) => {
    if (action === 'lookup')
      return payload.sessionId === 'ses_root' ? structuredClone(task) : null;
    if (action === 'fallback') {
      if (task.fallback_count) throw new Error('FALLBACK_UNSAFE');
      task.fallback_count++;
      task.actual_model = fallback;
    }
    return { ok: true };
  });
  const register = vi.fn(
    async (name: string, callback: (event: any) => Promise<void>) => {
      hooks.set(name, callback);
      return { dispose: vi.fn() };
    }
  );
  const fetcher = vi.fn(
    async () =>
      new Response('data: {"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  const ctx = {
    session: {
      hook: register,
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: sessionID === 'ses_root' ? {} : { parentID: 'ses_root' },
      })),
    },
    tool: { hook: register },
    model: {
      list: vi.fn(async () => ({
        data: ['a/main', 'b/backup'].map(m => ({
          providerID: m.split('/')[0],
          id: m.split('/')[1],
          modelID: m.split('/')[1],
          enabled: true,
          package: '@opencode/ai/providers/openai-compatible',
          capabilities: { tools: true },
          limit: { context: 4096 },
        })),
      })),
    },
  };
  const dispose = await installControl(ctx, {
    control,
    scope: 'a'.repeat(64),
    routes: [primary, fallback].map(selector => ({
      selector,
      protocol: 'openai-chat',
      url: 'https://provider.example/chat/completions',
      contextTokens: 4096,
      outputBoundIncludesReasoning: true,
    })),
    fetcher,
  });
  const request = () => ({
    sessionID: 'ses_root',
    model: { providerID: 'a', id: 'main', variant: 'default' },
    kind: 'primary',
    request: new Request('https://native.example/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'once' }],
        stream: true,
        max_tokens: 1000000,
      }),
    }),
  });
  return { hooks, task, control, fetcher, ctx, dispose, request };
}

describe('OpenCode physical request control', () => {
  it.each([429, 402, 403, 401, 503, 529, 500])(
    'keeps native and gateway classifications consistent (%s)',
    status => {
      for (const code of ['', 'insufficient_balance', 'insufficient_quota'])
        expect(classifyProviderFailure(status, code)).toBe(
          classifyOpenCodeProviderFailure(status, code)
        );
    }
  );
  it('reserves the full context and clamps output before the request escapes', async () => {
    const f = await fixture(),
      event = f.request();
    await f.hooks.get('http.request')!(event);
    expect(f.control).toHaveBeenCalledWith(
      'reserve',
      expect.objectContaining({
        inputTokens: 4096,
        outputTokens: 32,
        model: primary,
      })
    );
    expect(await event.request.json()).toMatchObject({
      max_tokens: 32,
      n: 1,
      stream_options: { include_usage: true },
    });
    expect(event.request.headers.get('x-wqn-attempt-id')).toBeTruthy();
  });
  it.each([
    [429, 'rate_limit_exceeded'],
    [403, 'insufficient_balance'],
  ])(
    'makes one replacement HTTP call for %s without re-admitting a prompt',
    async (status, code) => {
      const f = await fixture(),
        event: any = f.request();
      await f.hooks.get('http.request')!(event);
      event.response = Response.json(
        { error: { code } },
        { status, headers: { 'retry-after': '1200' } }
      );
      await f.hooks.get('http.response')!(event);
      await event.response.text();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.control.mock.calls.filter(c => c[0] === 'reserve')).toHaveLength(
        2
      );
      expect(f.control).toHaveBeenCalledWith(
        'settle',
        expect.objectContaining({ usedTokens: null })
      );
      expect(f.control).toHaveBeenCalledWith(
        'settle',
        expect.objectContaining({ usedTokens: 12 })
      );
      expect(f.task.fallback_count).toBe(1);
      expect(f.control).toHaveBeenCalledWith(
        'failure',
        expect.objectContaining({ retryAfterMs: 1200000 })
      );
    }
  );
  it('returns a failed backup and disables native retries', async () => {
    const f = await fixture(),
      event: any = f.request();
    f.fetcher.mockImplementation(async () =>
      Response.json({ error: {} }, { status: 429 })
    );
    await f.hooks.get('http.request')!(event);
    event.response = Response.json({ error: {} }, { status: 429 });
    await f.hooks.get('http.response')!(event);
    expect(event.response.status).toBe(429);
    const retry = { sessionID: 'ses_root', decision: { retry: true } };
    await f.hooks.get('retry')!(retry);
    expect(retry.decision).toEqual({ retry: false });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('denies a physical send when reservation fails', async () => {
    const f = await fixture();
    f.control.mockImplementation(async action => {
      if (action === 'reserve') throw new Error('BUDGET');
      return structuredClone(f.task);
    });
    await expect(f.hooks.get('http.request')!(f.request())).rejects.toThrow(
      'BUDGET'
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('marks output before exposing partial SSE and never replaces a successful response', async () => {
    const f = await fixture(),
      event: any = f.request();
    await f.hooks.get('http.request')!(event);
    event.response = new Response('data: partial\n\n');
    await f.hooks.get('http.response')!(event);
    expect(f.control).toHaveBeenCalledWith('activity', {
      taskId: 'task-1',
      output: true,
    });
    await event.response.text();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.control).toHaveBeenCalledWith(
      'settle',
      expect.objectContaining({ usedTokens: null })
    );
  });
  it('charges child and auxiliary calls to the root task and fences tools first', async () => {
    const f = await fixture(),
      event = { ...f.request(), sessionID: 'ses_child', kind: 'compaction' };
    await f.hooks.get('http.request')!(event);
    expect(f.control).toHaveBeenCalledWith(
      'reserve',
      expect.objectContaining({ taskId: 'task-1', kind: 'compaction' })
    );
    await f.hooks.get('execute.before')!({ sessionID: 'ses_child' });
    expect(f.control).toHaveBeenCalledWith('activity', {
      taskId: 'task-1',
      tool: true,
    });
  });
  it('blocks cancelled, expired, unadmitted, and websocket calls', async () => {
    const f = await fixture();
    await expect(
      f.hooks.get('prompt')!({ sessionID: 'ses_root' })
    ).rejects.toThrow('admission');
    await expect(
      f.hooks.get('experimental.ws.handshake')!({ sessionID: 'ses_root' })
    ).rejects.toThrow('metered HTTP');
    f.task.state = 'cancelled';
    await expect(f.hooks.get('http.request')!(f.request())).rejects.toThrow(
      'stopped'
    );
    f.task.state = 'armed';
    f.task.deadline = new Date(0).toISOString();
    await expect(f.hooks.get('http.request')!(f.request())).rejects.toThrow(
      'stopped'
    );
  });
  it('fails closed on backend outages and refuses insecure control endpoints', async () => {
    const f = await fixture();
    f.control.mockRejectedValue(new Error('OFFLINE'));
    await expect(f.hooks.get('http.request')!(f.request())).rejects.toThrow(
      'OFFLINE'
    );
    expect(() =>
      createControlClient('http://remote.example/control', 'x'.repeat(32))
    ).toThrow('HTTPS');
    const client = createControlClient(
      'https://app.example/control',
      'x'.repeat(32),
      vi.fn(async () => new Response('', { status: 409 }))
    );
    await expect(client('reserve', {})).rejects.toThrow('denied');
  });
});

it('rejects gateway admission when the native plugin has the wrong scope', async () => {
  const f = await fixture();
  f.control.mockResolvedValue(null as any);
  await expect(
    f.hooks.get('prompt')!({
      sessionID: 'ses_root',
      metadata: { wqn_task_id: 'task-1' },
    })
  ).rejects.toThrow('scope');
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('admits an internal child prompt under its original task', async () => {
  const f = await fixture();
  await f.hooks.get('prompt')!({ sessionID: 'ses_child' });
  expect(f.control).toHaveBeenCalledWith('bind', {
    taskId: 'task-1',
    sessionId: 'ses_child',
  });
});
