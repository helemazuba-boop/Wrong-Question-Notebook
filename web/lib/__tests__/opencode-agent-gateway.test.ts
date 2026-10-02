import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseOpenCodeDetail } from '@/lib/opencode-agent-detail';
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

  it('accepts an ask raised by a subagent of an owned session', async () => {
    // The relay arms a subagent's ask against the subagent's own session id,
    // because that is the session the reply has to be addressed to. The device
    // selector deliberately lists only root sessions, so without this the ask
    // was delivered to the device and then answered into a 404 -- the one
    // combination where an ask is both shown and unusable.
    //
    // The ownership is read from the candidate's own record, not by enumerating
    // children: the relay polls children every round anyway, and re-deriving the
    // same fact here on every action route costs one request per owned session.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/session/ses_child')) {
        return jsonResponse({
          data: {
            id: 'ses_child',
            parentID: 'ses_owned',
            time: { updated: 2 },
          },
        });
      }
      return jsonResponse({
        data: [{ id: 'ses_owned', time: { updated: 1 } }],
      });
    });

    await expect(
      assertOpenCodeSessionAccess(resolveOpenCodeBinding('user-1'), 'ses_child')
    ).resolves.toBeUndefined();
    // A child of a session this binding does not own is still refused: the
    // tenancy boundary is the parent's membership in the binding list.
    await expect(
      assertOpenCodeSessionAccess(resolveOpenCodeBinding('user-1'), 'ses_other')
    ).rejects.toThrow(OpenCodeSessionAccessError);
  });

  it('refuses a subagent whose parent it cannot read', async () => {
    // The parent comparison needs the candidate's record. An upstream that will
    // not hand it over is the same evidence as a session that does not exist:
    // this device has no claim on it. Passing here would turn one unreadable
    // session into an open door on every subagent id.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/session/ses_child')) {
        return new Response('nope', { status: 404 });
      }
      return jsonResponse({
        data: [{ id: 'ses_owned', time: { updated: 1 } }],
      });
    });

    await expect(
      assertOpenCodeSessionAccess(resolveOpenCodeBinding('user-1'), 'ses_child')
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

  it('does not abort a prompt response that outlives the generic 15s timeout', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_url: URL, init: RequestInit) =>
          new Promise<Response>(resolve => {
            observedSignal = init.signal ?? undefined;
            // 20s: past the generic DEFAULT_TIMEOUT_MS, inside the prompt
            // budget. The live server answers in ~2s, but a slower submit must
            // not be cut off at the generic bound.
            setTimeout(
              () =>
                resolve(
                  jsonResponse({
                    data: {
                      id: 'msg_1',
                      sessionID: 'ses_123',
                      time: {},
                      type: 'user',
                    },
                  })
                ),
              20_000
            );
          })
      );

      const pending = submitOpenCodePrompt(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        'slow submit'
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toBeUndefined();
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors WQN_OPENCODE_PROMPT_TIMEOUT_MS for a stalled prompt submit', async () => {
    vi.useFakeTimers();
    const previous = process.env.WQN_OPENCODE_PROMPT_TIMEOUT_MS;
    process.env.WQN_OPENCODE_PROMPT_TIMEOUT_MS = '5000';
    try {
      fetchMock.mockImplementation(
        (_url: URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          })
      );

      const pending = submitOpenCodePrompt(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        'stalled'
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'upstream_timeout',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
      if (previous === undefined) {
        delete process.env.WQN_OPENCODE_PROMPT_TIMEOUT_MS;
      } else {
        process.env.WQN_OPENCODE_PROMPT_TIMEOUT_MS = previous;
      }
    }
  });

  it('aborts the prompt fetch when the caller signal aborts', async () => {
    let observedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );

    const caller = new AbortController();
    const pending = submitOpenCodePrompt(
      resolveOpenCodeBinding('user-1'),
      'ses_123',
      'x',
      caller.signal
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'upstream_timeout',
    });
    caller.abort();
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
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

    it('trims by UTF-8 bytes, not JS string length', async () => {
      const rows = Array.from({ length: 40 }, (_, index) => ({
        id: `msg_${index}`,
        type: 'user',
        text: '汉'.repeat(2000),
      }));
      fetchMock.mockResolvedValue(jsonResponse({ data: rows }));

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      // 2000 CJK characters cost ~6 KB of UTF-8 but only ~2 KB of string
      // length; a character budget would keep six of these messages, while the
      // device's byte ceiling leaves room for two.
      expect(messages.length).toBe(2);
      expect(
        Buffer.byteLength(JSON.stringify(messages), 'utf8')
      ).toBeLessThanOrEqual(12 * 1024);
      expect(messages[messages.length - 1].text).toBe('汉'.repeat(2000));
    });

    it('collapses a turn to one digest ahead of its answer at the brief tier', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_tools_only',
              type: 'assistant',
              time: { created: 1_000, completed: 46_000 },
              content: [
                { type: 'reasoning', text: 'should not surface' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls' } },
                },
                {
                  type: 'tool',
                  id: 'call_2',
                  name: 'read',
                  state: { status: 'completed', input: { path: 'a.ts' } },
                },
              ],
            },
            {
              id: 'msg_asst',
              type: 'assistant',
              content: [
                { type: 'reasoning', text: 'thinking out loud' },
                { type: 'text', text: 'the answer' },
                {
                  type: 'tool',
                  id: 'call_3',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls -al' } },
                },
              ],
            },
            { id: 'msg_user', type: 'user', text: 'hello' },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      // One question, one turn: the tool work collapses into a single digest
      // ahead of the answer (three calls, 1s -> 46s), and the rounds that only
      // ran tools are not replies of their own.
      expect(messages).toEqual([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: '调用了 3 次工具 · 工作了 45 秒' },
        { role: 'assistant', text: 'the answer' },
      ]);
    });

    it('keeps only the last text of a turn, dropping between-round lead-ins', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            // Newest first, like upstream.
            {
              id: 'msg_final',
              type: 'assistant',
              content: [{ type: 'text', text: '答案在此' }],
            },
            {
              id: 'msg_lead_in',
              type: 'assistant',
              content: [
                { type: 'text', text: '让我看看：' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls' } },
                },
              ],
            },
            { id: 'msg_user', type: 'user', text: '这是什么？' },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      expect(messages).toEqual([
        { role: 'user', text: '这是什么？' },
        { role: 'assistant', text: '调用了 1 次工具' },
        { role: 'assistant', text: '答案在此' },
      ]);
    });

    it('leaves a turn with no tools as its answer alone at the brief tier', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_final',
              type: 'assistant',
              content: [{ type: 'text', text: '只有正文' }],
            },
            {
              id: 'msg_lead_in',
              type: 'assistant',
              content: [{ type: 'text', text: '让我看看：' }],
            },
            { id: 'msg_user', type: 'user', text: '问题' },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      // No tools, no digest: the answer alone, with the lead-in dropped.
      expect(messages).toEqual([
        { role: 'user', text: '问题' },
        { role: 'assistant', text: '只有正文' },
      ]);
    });

    it('aggregates a turn with no text into one digest over every tool', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            // Newest first: three tool-only rounds, no answer at all.
            {
              id: 'msg_round_3',
              type: 'assistant',
              time: { created: 21_000, completed: 26_000 },
              content: [
                {
                  type: 'tool',
                  id: 'call_3',
                  name: 'grep',
                  state: { status: 'completed', input: { pattern: 'x' } },
                },
              ],
            },
            {
              id: 'msg_round_2',
              type: 'assistant',
              time: { created: 11_000, completed: 14_000 },
              content: [
                {
                  type: 'tool',
                  id: 'call_2',
                  name: 'read',
                  state: { status: 'completed', input: { path: 'a.ts' } },
                },
              ],
            },
            {
              id: 'msg_round_1',
              type: 'assistant',
              time: { created: 1_000, completed: 5_000 },
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls' } },
                },
              ],
            },
            { id: 'msg_user', type: 'user', text: 'ping' },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      // Three rounds of one tool each, one question: a single digest, counted
      // over the turn and timed from the first round's start to the last
      // round's end (1s -> 26s).
      expect(messages).toEqual([
        { role: 'user', text: 'ping' },
        { role: 'assistant', text: '调用了 3 次工具 · 工作了 25 秒' },
      ]);
    });

    it('keeps every round as its own entry at the standard tier', async () => {
      // The brief tier's turn collapse must not leak into the tiers that show
      // the machinery: standard keeps one entry per round, tools attached.
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_round_2',
              type: 'assistant',
              content: [{ type: 'text', text: '答案在此' }],
            },
            {
              id: 'msg_round_1',
              type: 'assistant',
              content: [
                { type: 'text', text: '让我看看：' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls' } },
                },
              ],
            },
            { id: 'msg_user', type: 'user', text: '这是什么？' },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        1
      );

      expect(messages.map(message => message.text)).toEqual([
        '这是什么？',
        '让我看看：',
        '答案在此',
      ]);
      expect(messages[1].tools).toEqual([
        { name: 'bash', status: 'done', preview: 'ls' },
      ]);
    });

    it('keeps tools but drops thinking at the standard tier', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_asst',
              type: 'assistant',
              content: [
                { type: 'reasoning', text: 'thinking out loud' },
                { type: 'text', text: 'the answer' },
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls -al' } },
                },
              ],
            },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        1
      );

      expect(messages[0].thinking).toBeUndefined();
      expect(messages[0].tools).toEqual([
        { name: 'bash', status: 'done', preview: 'ls -al' },
      ]);
    });

    it('drops the duration from the brief digest when the turn has no timing', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_asst',
              type: 'assistant',
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'completed', input: { command: 'ls' } },
                },
              ],
            },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      expect(messages).toEqual([
        { role: 'assistant', text: '调用了 1 次工具' },
      ]);
    });

    it('lets a failed turn say why instead of how long it ran', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_asst',
              type: 'assistant',
              time: { created: 1_000, completed: 46_000 },
              error: { message: 'provider unavailable' },
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'bash',
                  state: { status: 'error', input: { command: 'ls' } },
                },
              ],
            },
          ],
        })
      );

      const messages = await loadOpenCodeMessages(
        resolveOpenCodeBinding('user-1'),
        'ses_123',
        0
      );

      expect(messages[0].text).toBe('provider unavailable');
    });

    it('clamps a tool text payload to the contract preview length', async () => {
      // A `read` tool answers with the file content in `state.content`; that
      // path used to skip the preview clamp and projected a single message to
      // 56 KB, over the device's 16 KiB ceiling.
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'msg_asst',
              type: 'assistant',
              content: [
                {
                  type: 'tool',
                  id: 'call_1',
                  name: 'read',
                  state: {
                    status: 'completed',
                    content: [{ type: 'text', text: 'x'.repeat(4000) }],
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

      // The contract pins `historyTool.preview` at 160, and the trimmer keeps at
      // least one message, so this clamp is the only thing between a huge read
      // output and an oversized response.
      expect(messages).toHaveLength(1);
      expect(messages[0].tools?.[0].preview).toBe('x'.repeat(160));
      expect(JSON.stringify(messages).length).toBeLessThan(1024);
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

    it('projects every visible form field without capping device options', async () => {
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
                // Hidden and conditionally-visible fields are skipped: the
                // device can neither see nor answer them.
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

      expect(forms).toHaveLength(2);
      expect(forms[0]).toMatchObject({
        id: 'frm_1',
        sessionId: 'ses_123',
        title: 'Pick a branch',
        // Form.Info has no state; only Form.Detail can answer pending/answered.
        status: '',
      });
      // Every visible field keeps its order and its own title (the form title
      // is a constant like "Questions"); non-option fields still project with
      // zero options so the device can step past them.
      expect(forms[0].fields).toEqual([
        {
          fieldKey: 'note',
          title: 'Pick a branch',
          options: [],
          optionCount: 0,
        },
        {
          fieldKey: 'answer',
          title: 'Pick a branch',
          options: [],
          optionCount: 0,
        },
        {
          fieldKey: 'target',
          title: 'Pick a branch',
          options: [],
          optionCount: 0,
        },
        {
          fieldKey: 'targets',
          title: 'Pick a branch',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
            { value: 'c', label: 'Gamma' },
            { value: 'd', label: 'd' },
          ],
          optionCount: 4,
        },
      ]);
      // A form with no visible field still projects one stub field so it stays
      // visible on the device instead of silently blocking the run.
      expect(forms[1]).toMatchObject({
        id: 'frm_nofields',
        sessionId: 'ses_123',
        fields: [
          {
            fieldKey: 'frm_nofields',
            title: 'OpenCode 提问',
            options: [],
            optionCount: 0,
          },
        ],
      });
    });

    it('clamps an over-long option value to the 256-code-point schema bound', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'frm_1',
              sessionID: 'ses_123',
              fields: [
                {
                  key: 'branch',
                  type: 'string',
                  options: [{ value: '😀'.repeat(300), label: 'Long' }],
                },
              ],
            },
          ],
        })
      );

      const forms = await listOpenCodeQuestions(
        resolveOpenCodeBinding('user-1'),
        'ses_123'
      );

      // The device echoes `value` back as the answer, and both the schema and
      // the reply route cap it at 256 code points -- an unclamped projection
      // would be rejected on the way back in.
      expect(forms[0].fields[0].options[0].value).toBe('😀'.repeat(256));
      expect(forms[0].fields[0].options[0].label).toBe('Long');
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
      expect(form?.fields).toHaveLength(1);
      expect(form?.fields[0].fieldKey).toBe('targets');
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

describe('parseOpenCodeDetail', () => {
  it('accepts the three tiers and falls back to full for anything else', () => {
    expect(parseOpenCodeDetail('0')).toBe(0);
    expect(parseOpenCodeDetail('1')).toBe(1);
    expect(parseOpenCodeDetail('2')).toBe(2);
    // Pre-tier firmware sends no parameter at all; a malformed one must not
    // quietly downgrade what the device sees.
    expect(parseOpenCodeDetail(null)).toBe(2);
    expect(parseOpenCodeDetail(undefined)).toBe(2);
    expect(parseOpenCodeDetail('')).toBe(2);
    expect(parseOpenCodeDetail('9')).toBe(2);
    expect(parseOpenCodeDetail('brief')).toBe(2);
  });
});
