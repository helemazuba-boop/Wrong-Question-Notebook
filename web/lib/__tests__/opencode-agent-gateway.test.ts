import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSseResponse } from '@/lib/ai-stream';
import { relayOpenCodeEvents } from '@/lib/opencode-agent-events';
import {
  listOpenCodeSessions,
  resolveOpenCodeBinding,
  submitOpenCodePrompt,
} from '@/lib/opencode-agent-gateway';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  process.env.WQN_OPENCODE_SERVER_URL = 'https://opencode.example.test:4096';
  process.env.WQN_OPENCODE_DIRECTORY = '/srv/project';
  process.env.WQN_OPENCODE_SERVER_USERNAME = 'opencode';
  process.env.WQN_OPENCODE_SERVER_PASSWORD = 'secret';
  process.env.WQN_OPENCODE_ALLOWED_USER_IDS = 'user-1';
  process.env.WQN_OPENCODE_AGENT = 'build';
  process.env.WQN_OPENCODE_PROVIDER_ID = 'openai';
  process.env.WQN_OPENCODE_MODEL_ID = 'gpt-test';
  delete process.env.WQN_OPENCODE_USER_BINDINGS_JSON;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode Agent gateway', () => {
  it('fails closed when a global binding has no user allowlist', () => {
    delete process.env.WQN_OPENCODE_ALLOWED_USER_IDS;

    expect(() => resolveOpenCodeBinding('user-1')).toThrow(
      'allowlist is not configured'
    );
  });

  it('lists bounded normalized sessions through the user binding', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'bad', title: 'skip' },
          {
            id: 'ses_old',
            title: 'Old',
            directory: '/srv/project',
            time: { updated: 1 },
          },
          {
            id: 'ses_new',
            title: 'New',
            directory: '/srv/project',
            time: { updated: 2 },
          },
        ]),
        { status: 200 }
      )
    );

    const sessions = await listOpenCodeSessions(
      resolveOpenCodeBinding('user-1')
    );

    expect(sessions.map(session => session.id)).toEqual(['ses_new', 'ses_old']);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('directory')).toBe('/srv/project');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('opencode:secret').toString('base64')}`
    );
  });

  it('submits the configured agent and model only after explicit invocation', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await submitOpenCodePrompt(
      resolveOpenCodeBinding('user-1'),
      'ses_123',
      'inspect the repository'
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      parts: [{ type: 'text', text: 'inspect the repository' }],
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-test' },
    });
  });

  it('filters other sessions and emits compact device events until idle', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const events = [
          {
            // A server-wide stream can have a stale idle transition buffered
            // before prompt_async is accepted. It must not complete this run.
            type: 'session.status',
            properties: { sessionID: 'ses_123', status: { type: 'idle' } },
          },
          {
            type: 'message.part.delta',
            properties: {
              sessionID: 'ses_other',
              field: 'text',
              delta: 'ignored',
            },
          },
          {
            type: 'session.status',
            properties: { sessionID: 'ses_123', status: { type: 'busy' } },
          },
          {
            type: 'message.part.delta',
            properties: {
              sessionID: 'ses_123',
              field: 'text',
              delta: 'hello',
            },
          },
          {
            type: 'session.status',
            properties: { sessionID: 'ses_123', status: { type: 'idle' } },
          },
        ];
        controller.enqueue(
          encoder.encode(
            events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
          )
        );
        controller.close();
      },
    });
    const response = createSseResponse(writer =>
      relayOpenCodeEvents({ upstream, writer, sessionId: 'ses_123' })
    );

    const text = await response.text();
    expect(text).toContain('event: agent.status');
    expect(text).toContain('event: agent.text.delta');
    expect(text).toContain('"delta":"hello"');
    expect(text).not.toContain('ignored');
    expect(text).toContain('"status":"idle"');
  });
});
