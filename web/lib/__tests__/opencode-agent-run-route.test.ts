import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/esp32/agent/sessions/[id]/run/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { authenticate, fetchMock } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: authenticate,
}));

describe('OpenCode Agent run route', () => {
  beforeEach(() => {
    _resetRateLimitStore();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    authenticate.mockResolvedValue({ userId: 'user-a', deviceId: 'device-1' });
    process.env.WQN_OPENCODE_USER_BINDINGS_JSON = JSON.stringify({
      'user-a': {
        baseUrl: 'https://agent-a.example.test',
        directory: '/workspaces/a',
        username: 'opencode',
        password: 'secret-a',
      },
      'user-b': {
        baseUrl: 'https://agent-b.example.test',
        directory: '/workspaces/b',
        username: 'opencode',
        password: 'secret-b',
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WQN_OPENCODE_USER_BINDINGS_JSON;
  });

  it('rejects a prompt without explicit on-device confirmation', async () => {
    const request = new NextRequest(
      'http://localhost/api/esp32/agent/sessions/ses_123/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'run a broad repository task' }),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: 'ses_123' }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'confirmation_required' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot run a session owned by another binding', async () => {
    // The v2 tenant boundary is the server-side `?directory=` scope: the
    // upstream list only ever contains this binding's own sessions, so an id
    // belonging to another binding is simply absent from it and the action
    // fails closed. (v1 compared a row's own directory against the binding,
    // which matched nothing and silently dropped every row.)
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'ses_owned_by_a',
              title: 'A session',
              time: { updated: 2 },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const request = new NextRequest(
      'http://localhost/api/esp32/agent/sessions/ses_owned_by_b/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'run a broad repository task',
          confirmed: true,
        }),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: 'ses_owned_by_b' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'session_not_found' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://agent-a.example.test');
    expect(url.pathname).toBe('/api/session');
    expect(url.searchParams.get('directory')).toBe('/workspaces/a');
    expect(init.method).toBe('GET');
  });

  it('subscribes to the event stream and writes agent.accepted before the prompt is submitted', async () => {
    const calls: string[] = [];
    let releasePrompt: (() => void) | null = null;
    const promptGate = new Promise<void>(resolve => {
      releasePrompt = resolve;
    });
    fetchMock.mockImplementation(async (url: URL, _init?: RequestInit) => {
      if (url.pathname === '/api/session') {
        calls.push('list');
        return new Response(
          JSON.stringify({ data: [{ id: 'ses_123', time: { updated: 1 } }] }),
          { status: 200 }
        );
      }
      if (url.pathname === '/api/event') {
        calls.push('event');
        return new Response(new ReadableStream({ start: c => c.close() }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      calls.push('prompt');
      // Hold the prompt open so the subscriber order and the first frame can
      // both be observed while the upstream request is still in flight.
      await promptGate;
      return new Response(
        JSON.stringify({ data: { sessionID: 'ses_123', type: 'user' } }),
        { status: 200 }
      );
    });

    const responsePromise = POST(
      new NextRequest('http://localhost/api/esp32/agent/sessions/ses_123/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'go', confirmed: true }),
      }),
      { params: Promise.resolve({ id: 'ses_123' }) }
    );

    // Subscribe-before-submit ordering: the event stream is opened before the
    // prompt request is issued.
    await vi.waitFor(() => expect(calls).toEqual(['list', 'event', 'prompt']));

    const response = await responsePromise;
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    // The accepted frame is already on the wire while the prompt is still
    // blocked, so the device never waits on headers for a whole run.
    expect(new TextDecoder().decode(value)).toContain('event: agent.accepted');

    releasePrompt?.();
    await reader.cancel().catch(() => undefined);
  });
});
