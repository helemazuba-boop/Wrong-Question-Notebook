import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/esp32/agent/sessions/[id]/run/route';

const { authenticate, fetchMock } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: authenticate,
}));

describe('OpenCode Agent run route', () => {
  beforeEach(() => {
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
    // Even if an upstream list response contains an out-of-scope row, the
    // binding directory check must exclude it before the action is admitted.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'ses_owned_by_a',
            title: 'A session',
            directory: '/workspaces/a',
            time: { updated: 2 },
          },
          {
            id: 'ses_owned_by_b',
            title: 'B session',
            directory: '/workspaces/b',
            time: { updated: 3 },
          },
        ]),
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
    expect(url.pathname).toBe('/session');
    expect(init.method).toBe('GET');
  });
});
