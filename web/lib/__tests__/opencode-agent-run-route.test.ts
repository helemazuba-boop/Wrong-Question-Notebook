import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/esp32/agent/sessions/[id]/run/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { authenticate, fetchMock, claimMock, completeMock } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchMock: vi.fn(),
  claimMock: vi.fn(),
  completeMock: vi.fn(),
}));

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: authenticate,
}));

vi.mock('@/lib/opencode-agent-run-idempotency', () => ({
  claimAgentRunRequest: claimMock,
  completeAgentRunRequest: completeMock,
  fingerprintAgentRunRequest: (input: {
    sessionId: string;
    text: string;
    detail: number;
  }) => `fp:${input.sessionId}:${input.text}:${input.detail}`,
}));

const REQUEST_ID = '0123456789abcdef';

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
    //
    // Two upstream calls, not one: the id is not a root we own, so it is read
    // directly to learn its `parentID` -- a subagent's ask is answered on the
    // subagent's own id, so "not a root I own" must not end the check. The
    // tenancy boundary is unchanged; only the number of requests to evaluate it
    // went up, and only on a session this binding does not hold.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/ses_owned_by_b') {
        // A root with no parent: nothing in this binding can own it.
        return new Response(
          JSON.stringify({ data: { id: 'ses_owned_by_b' } }),
          {
            status: 200,
          }
        );
      }
      return new Response(
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
      );
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://agent-a.example.test');
    expect(url.pathname).toBe('/api/session');
    expect(url.searchParams.get('directory')).toBe('/workspaces/a');
    expect(init.method).toBe('GET');
    const [candidateUrl] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(candidateUrl.pathname).toBe('/api/session/ses_owned_by_b');
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

  describe('run idempotency', () => {
    beforeEach(() => {
      completeMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
      delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
    });

    function runRequest(body: Record<string, unknown>): NextRequest {
      return new NextRequest(
        'http://localhost/api/esp32/agent/sessions/ses_123/run',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    }

    function params() {
      return { params: Promise.resolve({ id: 'ses_123' }) };
    }

    /** A run whose upstream answers the list, the event stream and the prompt. */
    function mockRunUpstream(options: { eventFrames?: string[] } = {}) {
      const encoder = new TextEncoder();
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/session') {
          return new Response(
            JSON.stringify({ data: [{ id: 'ses_123', time: { updated: 1 } }] }),
            { status: 200 }
          );
        }
        if (url.pathname === '/api/event') {
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const frame of options.eventFrames ?? []) {
                  controller.enqueue(encoder.encode(frame));
                }
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return new Response(
          JSON.stringify({ data: { sessionID: 'ses_123', type: 'user' } }),
          { status: 200 }
        );
      });
    }

    function upstreamPaths(): string[] {
      return fetchMock.mock.calls.map(
        ([input]) => new URL(String(input)).pathname
      );
    }

    const succeededFrame =
      'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_123"}}\n\n';

    it('claims a run, relays it to the terminator and writes completed back', async () => {
      claimMock.mockResolvedValue({ kind: 'claimed' });
      mockRunUpstream({ eventFrames: [succeededFrame] });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(200);
      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain('event: agent.accepted');
      expect(body).toContain('event: agent.status');
      expect(claimMock).toHaveBeenCalledWith({
        deviceId: 'device-1',
        requestId: REQUEST_ID,
        sessionId: 'ses_123',
        fingerprint: 'fp:ses_123:go:2',
      });
      expect(completeMock).toHaveBeenCalledWith({
        deviceId: 'device-1',
        requestId: REQUEST_ID,
        state: 'completed',
        errorCode: null,
      });
    });

    it('runs a stale re-claim through the full new flow', async () => {
      claimMock.mockResolvedValue({ kind: 'stale' });
      mockRunUpstream({ eventFrames: [succeededFrame] });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(upstreamPaths()).toContain('/api/session/ses_123/prompt');
      expect(completeMock).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'completed' })
      );
    });

    it('answers a conflicting reuse of the request id with 409', async () => {
      claimMock.mockResolvedValue({ kind: 'conflict' });
      mockRunUpstream();

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'request_id_conflict' },
      });
      expect(upstreamPaths()).toEqual(['/api/session']);
      expect(completeMock).not.toHaveBeenCalled();
    });

    it('answers a second in-flight run with 409', async () => {
      claimMock.mockResolvedValue({ kind: 'busy' });
      mockRunUpstream();

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'run_in_progress' },
      });
      expect(completeMock).not.toHaveBeenCalled();
    });

    it('fails closed when the ledger itself is unavailable', async () => {
      claimMock.mockResolvedValue({ kind: 'unavailable' });
      mockRunUpstream();

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'run_idempotency_unavailable' },
      });
      expect(upstreamPaths()).toEqual(['/api/session']);
    });

    it('replays a completed run as attached + idle without submitting', async () => {
      claimMock.mockResolvedValue({ kind: 'completed' });
      mockRunUpstream();

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      expect(response.status).toBe(200);
      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain('event: agent.attached');
      expect(body).toContain('"status":"idle"');
      expect(upstreamPaths()).toEqual(['/api/session']);
      expect(completeMock).not.toHaveBeenCalled();
    });

    it('replays a failed run as attached + error + idle', async () => {
      claimMock.mockResolvedValue({ kind: 'failed', errorCode: 'interrupted' });
      mockRunUpstream();

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain('event: agent.attached');
      expect(body).toContain('event: agent.error');
      expect(body).toContain('interrupted');
      expect(body).toContain('"status":"idle"');
      expect(upstreamPaths()).toEqual(['/api/session']);
      expect(completeMock).not.toHaveBeenCalled();
    });

    it('attaches a same-id retry to the live stream without resubmitting', async () => {
      claimMock.mockResolvedValue({ kind: 'attached' });
      mockRunUpstream({ eventFrames: [succeededFrame] });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain('event: agent.attached');
      expect(upstreamPaths()).not.toContain('/api/session/ses_123/prompt');
      // The attach is read-only: the original attempt owns the terminal write.
      expect(completeMock).not.toHaveBeenCalled();
    });

    it('writes failed back when the submit is rejected', async () => {
      claimMock.mockResolvedValue({ kind: 'claimed' });
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/session') {
          return new Response(
            JSON.stringify({ data: [{ id: 'ses_123', time: { updated: 1 } }] }),
            { status: 200 }
          );
        }
        if (url.pathname === '/api/event') {
          return new Response(new ReadableStream({ start: c => c.close() }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response('rejected', { status: 500 });
      });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain('OpenCode rejected the prompt');
      expect(completeMock).toHaveBeenCalledWith({
        deviceId: 'device-1',
        requestId: REQUEST_ID,
        state: 'failed',
        errorCode: 'submit_rejected',
      });
    });

    it('writes failed back when the relay throws', async () => {
      claimMock.mockResolvedValue({ kind: 'claimed' });
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/session') {
          return new Response(
            JSON.stringify({ data: [{ id: 'ses_123', time: { updated: 1 } }] }),
            { status: 200 }
          );
        }
        if (url.pathname === '/api/event') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('upstream exploded'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return new Response(
          JSON.stringify({ data: { sessionID: 'ses_123', type: 'user' } }),
          { status: 200 }
        );
      });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      await response.arrayBuffer();
      expect(completeMock).toHaveBeenCalledWith({
        deviceId: 'device-1',
        requestId: REQUEST_ID,
        state: 'failed',
        errorCode: 'stream_disconnected',
      });
    });

    it('retires the row as failed/detached when the device disconnects mid-run', async () => {
      // A client disconnect IS worth a terminal write, and this test is the
      // regression test for the bug that motivated it: leaving the row
      // in_flight pinned the (device, session) pair for the whole 30-minute
      // lease, so a device that vanished could not be told anything and just
      // got a busy signal for half an hour. The lease did retire the row
      // eventually, but "eventually, in 30 minutes" is not a recovery path.
      //
      // The old assertion here was `expect(completeMock).not.toHaveBeenCalled()`
      // with the comment "only the lease retires the row" -- that is exactly the
      // behaviour being fixed, so the assertion is inverted on purpose.
      process.env.WQN_OPENCODE_PENDING_POLL_MS = '20';
      claimMock.mockResolvedValue({ kind: 'claimed' });
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/session') {
          return new Response(
            JSON.stringify({ data: [{ id: 'ses_123', time: { updated: 1 } }] }),
            { status: 200 }
          );
        }
        if (url.pathname === '/api/event') {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(
          JSON.stringify({ data: { sessionID: 'ses_123', type: 'user' } }),
          { status: 200 }
        );
      });

      const response = await POST(
        runRequest({ text: 'go', confirmed: true, request_id: REQUEST_ID }),
        params()
      );

      const reader = response.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(
        'event: agent.accepted'
      );
      await reader.cancel().catch(() => undefined);

      // Give the relay's poll window time to notice the closed writer.
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(completeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'failed',
          errorCode: 'detached',
        })
      );
    });
  });
});
