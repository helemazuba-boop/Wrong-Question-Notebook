import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { relayOpenCodeEvents } from '@/lib/opencode-agent-events';
import {
  beginOrGetQuestionSequence,
  currentQuestionStep,
  recordQuestionAnswer,
  __resetQuestionSequencesForTest,
} from '@/lib/opencode-agent-question-sequence';
import {
  listOpenCodeQuestions,
  resolveOpenCodeBinding,
} from '@/lib/opencode-agent-gateway';
import { enforceAgentRateLimit } from '@/lib/opencode-agent-rate-limit';
import { _resetRateLimitStore } from '@/lib/rate-limit';
import { POST as interrupt } from '@/app/api/esp32/agent/sessions/[id]/interrupt/route';
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/lib/esp32-device-auth', () => ({ authenticateEsp32Device: auth }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetQuestionSequencesForTest();
  _resetRateLimitStore();
});
function configure() {
  vi.stubEnv(
    'WQN_OPENCODE_USER_BINDINGS_JSON',
    JSON.stringify({
      audit: {
        baseUrl: 'http://audit.invalid',
        directory: '/audit',
        model: 'stepfun/step-3.7-flash',
      },
    })
  );
  auth.mockResolvedValue({ userId: 'audit', deviceId: 'audit-device' });
}
function sink() {
  const emit = vi.fn();
  return { emit, comment: vi.fn(), isClosed: () => false };
}

it('can interrupt after all six run slots were consumed', async () => {
  configure();
  for (let i = 0; i < 6; i++)
    expect(enforceAgentRateLimit('audit-device', 'run')).toBeNull();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'ses_audit' }] }))
    .mockResolvedValueOnce(Response.json({ interrupted: true }));
  vi.stubGlobal('fetch', fetchMock);
  const r = await interrupt(
    new NextRequest(
      'http://localhost/api/esp32/agent/sessions/ses_audit/interrupt',
      { method: 'POST' }
    ),
    { params: Promise.resolve({ id: 'ses_audit' }) }
  );
  expect(r.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(['failed', 'interrupted'])(
  'preserves %s when observing a settled session',
  async outcome => {
    vi.stubEnv('WQN_OPENCODE_PENDING_POLL_MS', '5');
    const writer = sink();
    const probe = {
      activeSessions: async () => [],
      childSessions: async () => [],
      permissions: async () => [],
      questions: async () => [],
      formDetail: async () => null,
      sessionOutcome: async () => outcome,
    };
    await relayOpenCodeEvents({
      upstream: new ReadableStream({ start() {} }),
      writer,
      sessionId: 'ses_audit',
      mode: 'observe',
      probe,
    });
    expect(writer.emit.mock.calls.map(x => x[0])).toEqual([
      'agent.error',
      'agent.status',
    ]);
  }
);

it('polls and delivers permission despite continuous unrelated events', async () => {
  vi.stubEnv('WQN_OPENCODE_PENDING_POLL_MS', '10');
  const writer = sink();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  const probe = {
    activeSessions: vi.fn(async () => ['ses_audit']),
    childSessions: async () => [],
    permissions: async () => [
      {
        id: 'per_1',
        sessionId: 'ses_audit',
        title: 'Approve',
        action: 'shell',
        preview: 'echo ok',
      },
    ],
    questions: async () => [],
    formDetail: async () => null,
    sessionOutcome: async () => '',
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      let n = 0;
      timer = setInterval(() => {
        c.enqueue(
          encoder.encode(
            'data: {"type":"session.text.delta","data":{"sessionID":"ses_other","delta":"x"}}\n\n'
          )
        );
        if (++n === 60) {
          clearInterval(timer);
          c.close();
        }
      }, 1);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  await relayOpenCodeEvents({
    upstream: stream,
    writer,
    sessionId: 'ses_audit',
    probe,
  });
  expect(probe.activeSessions).toHaveBeenCalled();
  expect(writer.emit).toHaveBeenCalledWith(
    'agent.permission',
    expect.objectContaining({ permission_id: 'per_1' })
  );
});

async function projected(fields: unknown[]) {
  configure();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: [{ id: 'frm_audit', sessionID: 'ses_audit', fields }],
      })
    )
  );
  return (
    await listOpenCodeQuestions(resolveOpenCodeBinding('audit'), 'ses_audit')
  )[0];
}

it('answers a projected multiselect as an array', async () => {
  const form = await projected([
    { type: 'multiselect', key: 'pick', options: [{ value: 'a', label: 'A' }] },
  ]);
  beginOrGetQuestionSequence('ses_audit', form);
  expect(
    recordQuestionAnswer({
      sessionId: 'ses_audit',
      formId: form.id,
      step: 0,
      answer: 'a',
    })
  ).toEqual({ status: 'final', answers: { pick: ['a'] } });
});

it('does not offer partial submission when an unsupported required field remains', async () => {
  const form = await projected([
    {
      type: 'string',
      key: 'pick',
      options: [{ value: 'a', label: 'A' }],
      required: true,
    },
    { type: 'number', key: 'count', required: true },
  ]);
  const sequence = beginOrGetQuestionSequence('ses_audit', form);
  expect(currentQuestionStep(sequence)?.options).toEqual([]);
  expect(
    recordQuestionAnswer({
      sessionId: 'ses_audit',
      formId: form.id,
      step: 0,
      answer: 'a',
    }).status
  ).toBe('stale');
});

it('roundtrips distinct long values and exposes no full identity on the device', async () => {
  const a = 'x'.repeat(300) + 'a';
  const b = 'x'.repeat(300) + 'b';
  const form = await projected([
    {
      type: 'string',
      key: 'pick',
      options: [
        { value: a, label: 'A' },
        { value: b, label: 'B' },
      ],
    },
  ]);
  const step = currentQuestionStep(
    beginOrGetQuestionSequence('ses_audit', form)
  )!;
  expect(step.options[0].value).not.toBe(step.options[1].value);
  expect(step.options[0]).not.toHaveProperty('upstreamValue');
  expect(
    recordQuestionAnswer({
      sessionId: 'ses_audit',
      formId: form.id,
      step: 0,
      answer: step.options[1].value,
    })
  ).toEqual({ status: 'final', answers: { pick: b } });
});

it('announces a fast native fallback once before the terminal idle', async () => {
  const writer = sink();
  const routing = vi.fn(async () => ({
    taskId: 'fixed-task',
    model: 'backup/model',
    reason: 'rate_limited',
  }));
  const probe = {
    activeSessions: async () => [],
    childSessions: async () => [],
    permissions: async () => [],
    questions: async () => [],
    formDetail: async () => null,
    sessionOutcome: async () => '',
    routing,
  };
  const bytes = new TextEncoder().encode(
    'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_audit"}}\n\n'
  );
  await relayOpenCodeEvents({
    upstream: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    writer,
    sessionId: 'ses_audit',
    probe,
  });
  const statuses = writer.emit.mock.calls
    .filter(([name]) => name === 'agent.status')
    .map(([, data]) => data);
  expect(statuses).toEqual([
    expect.objectContaining({
      status: 'retry',
      attempt: 1,
      message: expect.stringContaining('backup/model'),
    }),
    expect.objectContaining({ status: 'idle' }),
  ]);
});
