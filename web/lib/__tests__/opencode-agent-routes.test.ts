import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/esp32/agent/sessions/route';
import { POST as runPermission } from '@/app/api/esp32/agent/sessions/[id]/permission/route';
import { GET as streamEvents } from '@/app/api/esp32/agent/sessions/[id]/events/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { authenticate, fetchMock } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: authenticate,
}));

// The binding-scoped list is the ownership authority. v2 wraps it in {data}
// and does not put a directory on each row.
const OWNED_LIST = JSON.stringify({
  data: [
    {
      id: 'ses_owned',
      title: 'Owned',
      location: { directory: '/workspaces/a' },
      time: { updated: 2 },
    },
  ],
});

function authedRequest(
  url: string,
  init: { method: string; body?: string }
): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body,
  });
}

describe('OpenCode Agent session create route', () => {
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WQN_OPENCODE_USER_BINDINGS_JSON;
  });

  it('creates a session and returns it in the agent envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'ses_new9' } }), {
        status: 200,
      })
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'ses_new9',
            location: { directory: '/workspaces/a' },
            time: { updated: 5 },
          },
        }),
        { status: 200 }
      )
    );

    const response = await POST(
      authedRequest('http://localhost/api/esp32/agent/sessions', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { session: { id: 'ses_new9' } },
    });
  });

  it('rate limits session creation per device', async () => {
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ data: { id: 'ses_burst' } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          data: {
            id: 'ses_burst',
            location: { directory: '/workspaces/a' },
            time: { updated: 5 },
          },
        }),
        { status: 200 }
      );
    });

    for (let i = 0; i < 20; i += 1) {
      const allowed = await POST(
        authedRequest('http://localhost/api/esp32/agent/sessions', {
          method: 'POST',
        })
      );
      expect(allowed.status).toBe(200);
    }
    const blocked = await POST(
      authedRequest('http://localhost/api/esp32/agent/sessions', {
        method: 'POST',
      })
    );
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'rate_limited' },
    });
  });
});

describe('OpenCode Agent permission route', () => {
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WQN_OPENCODE_USER_BINDINGS_JSON;
  });

  it('rejects a reply without explicit on-device confirmation', async () => {
    const response = await runPermission(
      authedRequest(
        'http://localhost/api/esp32/agent/sessions/ses_owned/permission',
        {
          method: 'POST',
          body: JSON.stringify({ permission_id: 'perm-1', decision: 'once' }),
        }
      ),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'confirmation_required' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot reply on a session owned by another binding', async () => {
    fetchMock.mockResolvedValueOnce(new Response(OWNED_LIST, { status: 200 }));

    const response = await runPermission(
      authedRequest(
        'http://localhost/api/esp32/agent/sessions/ses_other/permission',
        {
          method: 'POST',
          body: JSON.stringify({
            permission_id: 'perm-1',
            decision: 'reject',
            confirmed: true,
          }),
        }
      ),
      { params: Promise.resolve({ id: 'ses_other' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'session_not_found' },
    });
  });

  it('forwards an approve decision to the binding-scoped reply endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(OWNED_LIST, { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await runPermission(
      authedRequest(
        'http://localhost/api/esp32/agent/sessions/ses_owned/permission',
        {
          method: 'POST',
          body: JSON.stringify({
            permission_id: 'perm-1',
            decision: 'once',
            confirmed: true,
          }),
        }
      ),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    // The v2 reply path is session-scoped and carries `decision`, not `reply`.
    expect(url.pathname).toBe('/api/session/ses_owned/permission/perm-1/reply');
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'once' });
  });
});

describe('OpenCode Agent observe events route', () => {
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WQN_OPENCODE_USER_BINDINGS_JSON;
  });

  it('relays session events after an agent.attached frame', async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce(new Response(OWNED_LIST, { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'session.step.started',
            data: { sessionID: 'ses_owned' },
          })}\n\n`
        ),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      )
    );

    const response = await streamEvents(
      new NextRequest(
        'http://localhost/api/esp32/agent/sessions/ses_owned/events'
      ),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: agent.attached');
    expect(text).toContain('event: agent.status');
    expect(text).toContain('"status":"busy"');
    const [, eventInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(eventInit.method).toBe('GET');
  });

  it('ends an observe attach once the upstream reports the run is over', async () => {
    // v2's event stream is live-only: attaching to a finished run delivers
    // nothing at all, so without the outcome read the device would sit in
    // kRunning for the whole 30-minute cap and report the watch as failed.
    process.env.WQN_OPENCODE_PENDING_POLL_MS = '4';
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/api/session') {
        return new Response(OWNED_LIST, { status: 200 });
      }
      if (url.pathname === '/api/session/active') {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      if (url.pathname === '/api/session/ses_owned') {
        return new Response(
          JSON.stringify({ data: { id: 'ses_owned', outcome: 'succeeded' } }),
          { status: 200 }
        );
      }
      // The event stream itself never yields a single byte.
      return new Response(new ReadableStream({ cancel() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    try {
      const response = await streamEvents(
        authedRequest(
          'http://localhost/api/esp32/agent/sessions/ses_owned/events',
          {
            method: 'GET',
          }
        ),
        { params: Promise.resolve({ id: 'ses_owned' }) }
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('event: agent.attached');
      // The terminator is driven by the outcome read, not by anything the
      // silent event stream sent.
      expect(text).toContain('"status":"idle"');
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => (url as URL).pathname === '/api/session/ses_owned'
        ).length
      ).toBeGreaterThan(0);
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => (url as URL).pathname === '/api/session/active'
        ).length
      ).toBeGreaterThan(0);
    } finally {
      delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
    }
  });

  it('cannot observe a session owned by another binding', async () => {
    // Two upstream calls, not one: the id is not a root this binding owns, so it
    // is read directly to learn its `parentID` -- a subagent's ask is answered
    // on the subagent's own id, so "not a root I own" must not end the check.
    // The tenancy boundary is unchanged; only the request count went up, and only
    // for a session this binding does not hold.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/ses_other') {
        return new Response(JSON.stringify({ data: { id: 'ses_other' } }), {
          status: 200,
        });
      }
      return new Response(OWNED_LIST, { status: 200 });
    });

    const response = await streamEvents(
      new NextRequest(
        'http://localhost/api/esp32/agent/sessions/ses_other/events'
      ),
      { params: Promise.resolve({ id: 'ses_other' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'session_not_found' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [candidateUrl] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(candidateUrl.pathname).toBe('/api/session/ses_other');
  });
});
