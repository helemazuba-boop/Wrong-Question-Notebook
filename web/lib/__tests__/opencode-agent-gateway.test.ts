import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertOpenCodeSessionAccess,
  createOpenCodeSession,
  interruptOpenCodeSession,
  listOpenCodeActiveSessions,
  listOpenCodeChildSessions,
  listOpenCodePermissions,
  listOpenCodeQuestions,
  loadOpenCodeFormDetail,
  loadOpenCodeMessages,
  loadOpenCodeSessionOutcome,
  OpenCodeSessionAccessError,
  replyOpenCodePermission,
  replyOpenCodeQuestion,
  resolveOpenCodeBinding,
  submitOpenCodePrompt,
  listOpenCodeSessions,
} from '@/lib/opencode-agent-gateway';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

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
      jsonResponse({
        data: [
          { id: 'bad', title: 'skip' },
          { id: 'ses_old', title: 'Old', time: { updated: 1 } },
          // Session.Info.title is optional upstream; the device needs a label.
          { id: 'ses_new', time: { updated: 2 } },
        ],
        cursor: 'next-page',
      })
    );

    const sessions = await listOpenCodeSessions(
      resolveOpenCodeBinding('user-1')
    );

    expect(sessions.map(session => session.id)).toEqual(['ses_new', 'ses_old']);
    expect(sessions[0].title).toBe('新 Session');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session');
    expect(url.searchParams.get('directory')).toBe('/srv/project');
    // `order=updated.desc` is rejected with a 400 by the v2 server; `desc` is
    // the only spelling that works.
    expect(url.searchParams.get('order')).toBe('desc');
    // Subagent sessions must not enter the device selector.
    expect(url.searchParams.get('parentID')).toBe('null');
    expect(url.searchParams.get('limit')).toBe('12');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('opencode:secret').toString('base64')}`
    );
  });

  it('keeps sessions whose own directory differs from the binding directory', async () => {
    // A session's location.directory is its worktree, not the binding's startup
    // directory. v1 compared them and dropped every row, which also made every
    // action-time ownership re-check 404.
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'ses_elsewhere',
            location: { directory: 'D:\\projects\\D\\Duty-Agent' },
            time: { updated: 1 },
          },
        ],
      })
    );

    const sessions = await listOpenCodeSessions(
      resolveOpenCodeBinding('user-1')
    );

    expect(sessions.map(session => session.id)).toEqual(['ses_elsewhere']);
  });

  it('re-asserts session ownership through the binding-scoped list', async () => {
    // A Response body can only be read once, so the mock must hand out a fresh
    // one per call rather than the same resolved value.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: [{ id: 'ses_owned', time: { updated: 1 } }] })
    );

    await expect(
      assertOpenCodeSessionAccess(resolveOpenCodeBinding('user-1'), 'ses_owned')
    ).resolves.toBeUndefined();
    await expect(
      assertOpenCodeSessionAccess(
        resolveOpenCodeBinding('user-1'),
        'ses_not_owned'
      )
    ).rejects.toThrow(OpenCodeSessionAccessError);
  });

  it('submits the prompt text with steer delivery and no agent or model', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { id: 'msg_1', sessionID: 'ses_123', time: {}, type: 'user' },
      })
    );

    await submitOpenCodePrompt(
      resolveOpenCodeBinding('user-1'),
      'ses_123',
      'inspect the repository'
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_123/prompt');
    expect(init.method).toBe('POST');
    // v2 moved the agent/model onto session creation: the prompt request only
    // accepts text + delivery.
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'inspect the repository',
      delivery: 'steer',
    });
  });

  it('treats a 204 as an accepted prompt', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      submitOpenCodePrompt(resolveOpenCodeBinding('user-1'), 'ses_123', 'x')
    ).resolves.toBeUndefined();
  });

  it('rejects a prompt response that is not a user message for this session', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { id: 'msg_1', sessionID: 'ses_other', type: 'assistant' },
      })
    );

    await expect(
      submitOpenCodePrompt(resolveOpenCodeBinding('user-1'), 'ses_123', 'x')
    ).rejects.toThrow('not an accepted user message');
  });

  it('creates a session in the binding directory and verifies it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'ses_new1' } }));
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          id: 'ses_new1',
          location: { directory: '/srv/project' },
          time: { updated: 3 },
        },
      })
    );

    const session = await createOpenCodeSession(
      resolveOpenCodeBinding('user-1')
    );

    expect(session.id).toBe('ses_new1');
    expect(session.updatedAt).toBe(3);
    const [createCall, detailCall] = fetchMock.mock.calls as [
      [URL, RequestInit],
      [URL, RequestInit],
    ];
    expect(createCall[0].pathname).toBe('/api/session');
    expect(createCall[1].method).toBe('POST');
    expect(JSON.parse(String(createCall[1].body))).toEqual({
      location: { directory: '/srv/project' },
      agent: 'build',
      model: { id: 'gpt-test', providerID: 'openai' },
    });
    expect(detailCall[0].pathname).toBe('/api/session/ses_new1');
    expect(detailCall[1].method).toBe('GET');
  });

  it('fails closed when a created session cannot be read back', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'ses_stray' } })
    );
    // The targeted detail read resolves to a different id: the created session
    // is not usable and must never reach the device selector.
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'ses_other' } }));

    await expect(
      createOpenCodeSession(resolveOpenCodeBinding('user-1'))
    ).rejects.toThrow('not readable after creation');
  });

  it('fails closed when session creation returns the v1 bare-object shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ses_v1' }));

    await expect(
      createOpenCodeSession(resolveOpenCodeBinding('user-1'))
    ).rejects.toThrow('returned an invalid id');
  });

  it('replies to a permission on the session-scoped v2 endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await replyOpenCodePermission(
      resolveOpenCodeBinding('user-1'),
      'ses_123',
      'perm req/1',
      'once'
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(
      '/api/session/ses_123/permission/perm%20req%2F1/reply'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'once' });
  });

  it('turns a device reject into a corrective rejection with a message', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await replyOpenCodePermission(
      resolveOpenCodeBinding('user-1'),
      'ses_123',
      'perm-1',
      'reject'
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      decision: 'reject',
      message: 'Rejected from WQN Note4',
    });
  });

  describe('message history (v2 only)', () => {
    it('projects the 11-way message union oldest-first', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            // Newest first, as `order=desc` returns.
            {
              id: 'msg_idle',
              time: { created: 4 },
              type: 'idle',
              outcome: 'succeeded',
            },
            {
              id: 'msg_asst',
              time: { created: 3 },
              type: 'assistant',
              agent: 'build',
              model: { id: 'gpt-test', providerID: 'openai' },
              finish: 'stop',
              content: [
                { type: 'reasoning', text: 'thinking out loud' },
                { type: 'text', text: 'the answer' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  // `executed` is false even for completed calls; state.status
                  // is the only reliable signal.
                  executed: false,
                  state: {
                    status: 'completed',
                    input: { command: 'ls -al' },
                    content: [{ type: 'text', text: 'total 0' }],
                  },
                },
              ],
            },
            {
              id: 'msg_user',
              time: { created: 2 },
              type: 'user',
              text: 'hello',
            },
            // Upstream bookkeeping kinds have no device representation.
            {
              id: 'msg_sys',
              time: { created: 1 },
              type: 'system',
              text: 'ignored',
            },
          ],
          cursor: { next: 'abc' },
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      expect(messages).toEqual([
        { role: 'user', text: 'hello' },
        {
          role: 'assistant',
          text: 'the answer',
          thinking: 'thinking out loud',
          tools: [{ name: 'bash', status: 'done', preview: 'ls -al' }],
        },
      ]);
      const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe('/api/session/ses_123/message');
      expect(url.searchParams.get('order')).toBe('desc');
    });

    it('maps a failed tool state to error and surfaces an empty failed turn', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_asst',
              type: 'assistant',
              finish: 'error',
              error: { message: 'provider unavailable' },
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: {
                    status: 'error',
                    input: { command: 'ls' },
                    error: 'command not found',
                  },
                },
              ],
            },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      expect(messages[0].tools?.[0]).toEqual({
        name: 'bash',
        status: 'error',
        preview: 'ls',
      });
      expect(messages[0].text).toBe('provider unavailable');
    });

    it('drops oldest messages until the response fits the device budget', async () => {
      const rows = Array.from({ length: 40 }, (_, index) => ({
        id: `msg_${index}`,
        type: 'user',
        text: 'x'.repeat(2000),
      }));
      fetchMock.mockResolvedValue(jsonResponse({ data: rows }));

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      // The device's JSON ceiling is 16 KiB and the relay budget is 12 KiB, so
      // a handful of full-length messages is all that survives.
      expect(messages.length).toBeLessThan(40);
      expect(JSON.stringify(messages).length).toBeLessThanOrEqual(12 * 1024);
      // Newest survive: the last row is the newest.
      expect(messages[messages.length - 1].text).toBe('x'.repeat(2000));
    });
  });

  describe('pending asks (v2 only)', () => {
    it('reads a permission request from its message and resources', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'per_1',
              sessionID: 'ses_123',
              action: 'bash',
              resources: ['rm -rf /tmp/build'],
              message: 'Run rm -rf /tmp/build?',
              metadata: {},
            },
            // A row with no id can never be answered from the device; it would
            // only block the run behind a dead prompt.
            { action: 'bash', message: 'no id' },
          ],
        })
      );

      const requests = await listOpenCodePermissions(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      expect(requests).toEqual([
        {
          id: 'per_1',
          sessionId: 'ses_123',
          action: 'bash',
          title: 'Run rm -rf /tmp/build?',
          preview: 'rm -rf /tmp/build',
        },
      ]);
    });

    it('falls back to the action when a permission request has no message', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [{ id: 'per_1', action: 'edit', resources: ['src/app.ts'] }],
        })
      );

      const requests = await listOpenCodePermissions(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      // Still answerable by id: dropping it would stall the run instead.
      expect(requests).toEqual([
        {
          id: 'per_1',
          sessionId: 'ses_123',
          action: 'edit',
          title: 'edit src/app.ts',
          preview: 'src/app.ts',
        },
      ]);
    });

    it('projects the first answerable form field and caps device options at two', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'frm_1',
              sessionID: 'ses_123',
              title: 'Pick a branch',
              fields: [
                { key: 'note', type: 'string', options: [] },
                { key: 'answer', type: 'string', options: [] },
                // Hidden and conditionally-visible fields cannot be answered
                // from a two-button device.
                {
                  key: 'branch',
                  type: 'string',
                  hidden: true,
                  options: [{ value: 'main', label: 'main' }],
                },
                {
                  key: 'mode',
                  type: 'string',
                  when: [{ key: 'note', op: 'neq', value: '' }],
                  options: [{ value: 'fast', label: 'Fast' }],
                },
                { key: 'target', type: 'boolean' },
                {
                  key: 'targets',
                  type: 'multiselect',
                  options: [
                    { value: 'a', label: 'Alpha' },
                    { value: 'b', label: 'Beta' },
                    { value: 'c', label: 'Gamma' },
                    { value: 'd' },
                  ],
                },
              ],
            },
            { id: 'frm_nofields', fields: [] },
          ],
        })
      );

      const forms = await listOpenCodeQuestions(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      expect(forms).toHaveLength(1);
      expect(forms[0]).toMatchObject({
        id: 'frm_1',
        sessionId: 'ses_123',
        title: 'Pick a branch',
        // Form.Info has no state; only Form.Detail can answer pending/answered.
        status: '',
        fieldKey: 'targets',
        optionCount: 4,
      });
      expect(forms[0].options).toEqual([
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]);
    });

    it('reads form state from the detail endpoint only', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: {
            id: 'frm_1',
            sessionID: 'ses_123',
            fields: [
              {
                key: 'targets',
                type: 'multiselect',
                options: [{ value: 'a', label: 'Alpha' }],
              },
            ],
            // Form.State is a union keyed on status; only Detail carries it.
            state: { status: 'answered', answer: { targets: ['a'] } },
          },
        })
      );

      const form = await loadOpenCodeFormDetail(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        'frm_1'
      );

      expect(form?.status).toBe('answered');
      expect(form?.fieldKey).toBe('targets');
      const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe('/api/session/ses_123/form/frm_1');
    });

    it('assembles the answer record the form field expects', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      await replyOpenCodeQuestion(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        'frm_1',
        { targets: 'a' }
      );

      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe('/api/session/ses_123/form/frm_1/reply');
      // The device only ever sends a chosen option value; the field key is
      // cloud-side knowledge.
      expect(JSON.parse(String(init.body))).toEqual({
        answer: { targets: 'a' },
      });
    });

    it('lists active session ids from the active map', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: {
            ses_123: { type: 'running' },
            ses_child: { type: 'running' },
          },
        })
      );

      await expect(
        listOpenCodeActiveSessions(resolveOpenCodeBinding('user-1'))
      ).resolves.toEqual(['ses_123', 'ses_child']);
    });

    it('lists spawned child sessions for a parent', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            { id: 'ses_child', parentID: 'ses_123', time: { updated: 2 } },
            { id: 'ses_child2', parentID: 'ses_123', time: { updated: 1 } },
          ],
        })
      );

      const children = await listOpenCodeChildSessions(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      expect(children.map(child => child.id)).toEqual([
        'ses_child',
        'ses_child2',
      ]);
      const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.searchParams.get('parentID')).toBe('ses_123');
    });

    it('interrupts a submitted run', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ data: { interrupted: true } })
      );

      await expect(
        interruptOpenCodeSession(resolveOpenCodeBinding('user-1'), 'ses_123')
      ).resolves.toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe('/api/session/ses_123/interrupt');
      expect(init.method).toBe('POST');
    });

    it('reads the unwrapped interrupt response upstream actually sends', async () => {
      // SessionInterruptResponse is bare `{interrupted}`, unlike the `{data}`
      // every other v2 route wraps its body in. Reading `.data.interrupted`
      // made a successful stop of an already-finished run (interrupted:false)
      // report as delivered.
      fetchMock.mockResolvedValue(jsonResponse({ interrupted: false }));

      await expect(
        interruptOpenCodeSession(resolveOpenCodeBinding('user-1'), 'ses_123')
      ).resolves.toBe(false);
    });

    it('reads the run outcome that only exists on a finished session', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ data: { id: 'ses_123', outcome: 'succeeded' } })
      );

      await expect(
        loadOpenCodeSessionOutcome(resolveOpenCodeBinding('user-1'), 'ses_123')
      ).resolves.toBe('succeeded');
    });

    it('returns an empty outcome for a session that never ran', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'ses_123' } }));

      await expect(
        loadOpenCodeSessionOutcome(resolveOpenCodeBinding('user-1'), 'ses_123')
      ).resolves.toBe('');
    });
  });
});
