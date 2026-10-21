import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeToolOverHttp,
  injectToolResult,
} from '@/server/realtime-proxy/src/toolInterceptor';

const endpoint = 'http://app.test/api/esp32/ai/execute-tool';
const secret = 'transport-test-secret';
const call = {
  call_id: 'call-1',
  name: 'create_notebook_note',
  raw_args: '{"content":"private body"}',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('voice internal tool transport', () => {
  it('signs the exact body and reuses its operation ID across retries', async () => {
    const result = {
      ok: true,
      display: 'Note saved',
      action: null,
      data: { note: { id: 'note-1' } },
    };
    const fetcher = vi
      .fn()
      .mockImplementation(async () => Response.json({ success: true, result }));
    vi.stubGlobal('fetch', fetcher);
    for (let i = 0; i < 2; i++)
      expect(
        await executeToolOverHttp(
          endpoint,
          secret,
          'user',
          'device',
          call,
          '2026-10-21T00:00:00Z'
        )
      ).toEqual(result);
    const options = fetcher.mock.calls[0][1];
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      user_id: 'user',
      device_id: 'device',
      tool_name: call.name,
      anchor_at: '2026-10-21T00:00:00Z',
    });
    expect(body.request_id).toBe(
      JSON.parse(fetcher.mock.calls[1][1].body).request_id
    );
    expect(options.headers['x-wqn-internal-signature']).toBe(
      createHmac('sha256', secret)
        .update(options.headers['x-wqn-internal-timestamp'])
        .update('\n')
        .update(options.body)
        .digest('hex')
    );
  });
  it.each([401, 400, 503])(
    'preserves a definitive internal rejection (%i)',
    async status => {
      const code =
        status === 401
          ? 'unauthorized'
          : status === 400
            ? 'bad_request'
            : 'disabled';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            {
              success: false,
              error: { code, message: 'private server detail' },
            },
            { status }
          )
        )
      );
      const result = await executeToolOverHttp(
        endpoint,
        secret,
        'user',
        'device',
        call
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code, retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain('private server detail');
      const sent: string[] = [];
      injectToolResult(
        { sendText: message => sent.push(message) },
        call,
        result
      );
      expect(JSON.parse(JSON.parse(sent[0]).item.output).error.code).toBe(code);
    }
  );
  it.each(['network', 'invalid-json', 'gateway', 'invalid-envelope'])(
    'keeps write outcome unknown after %s',
    async mode => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          if (mode === 'network') throw new Error('private transport detail');
          if (mode === 'gateway')
            return new Response('bad gateway', { status: 502 });
          if (mode === 'invalid-envelope')
            return Response.json({ success: true, result: {} });
          return new Response('not JSON');
        })
      );
      const result = await executeToolOverHttp(
        endpoint,
        secret,
        'user',
        'device',
        call
      );
      expect(result).toMatchObject({
        ok: false,
        action: null,
        error: { code: 'unknown_outcome', retryable: true },
      });
      expect(JSON.stringify(result)).not.toContain('private transport detail');
    }
  );
  it('reports a 12-second HTTP timeout as an uncertain write without retrying a new request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    vi.stubGlobal('fetch', fetcher);
    const pending = executeToolOverHttp(
      endpoint,
      secret,
      'user',
      'device',
      call
    );
    await vi.advanceTimersByTimeAsync(12000);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'unknown_outcome' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a failed read from an uncertain mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(
      await executeToolOverHttp(endpoint, secret, 'user', 'device', {
        ...call,
        name: 'list_todos',
      })
    ).toMatchObject({ error: { code: 'tool_transport_failed' } });
  });
  it('keeps a business error returned inside a successful HTTP envelope', async () => {
    const result = {
      ok: false,
      display: 'Writing note failed',
      action: null,
      error: { code: 'notebook_permission_denied', message: '需要授权' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: true, result }))
    );
    expect(
      await executeToolOverHttp(endpoint, secret, 'user', 'device', call)
    ).toEqual(result);
  });
});
