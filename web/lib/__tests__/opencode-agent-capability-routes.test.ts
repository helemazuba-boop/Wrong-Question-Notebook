import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as loadHistory } from '@/app/api/esp32/agent/sessions/[id]/history/route';
import { POST as interruptRun } from '@/app/api/esp32/agent/sessions/[id]/interrupt/route';
import { POST as replyQuestion } from '@/app/api/esp32/agent/sessions/[id]/question/route';
import { __resetQuestionSequencesForTest } from '@/lib/opencode-agent-question-sequence';
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

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

function ownedListResponse(): Response {
  return new Response(OWNED_LIST, { status: 200 });
}

describe('OpenCode Agent capability routes', () => {
  beforeEach(() => {
    _resetRateLimitStore();
    // The sequence store is process-level and shared by the relay and this
    // route; a leftover sequence would make a later test look answered.
    __resetQuestionSequencesForTest();
    // `clearAllMocks` records but does not drain one-shot queues, so a test
    // that throws early would leak its unconsumed response into the next one.
    fetchMock.mockReset();
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

  it('returns the projected history oldest-first', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            // Newest first, as `order=desc` returns; the cloud reverses it.
            {
              id: 'm3',
              time: { created: 3 },
              type: 'assistant',
              content: [
                { type: 'reasoning', text: '先想一下再答' },
                { type: 'text', text: '浮力等于排开液体的重量' },
              ],
            },
            {
              id: 'm1',
              time: { created: 2 },
              type: 'user',
              text: '讲一下浮力',
            },
            // Turn boundaries and upstream bookkeeping kinds project to nothing.
            {
              id: 'm2',
              time: { created: 1 },
              type: 'idle',
              outcome: 'succeeded',
            },
          ],
          cursor: { previous: 'm0', next: 'm4' },
        }),
        { status: 200 }
      )
    );

    const response = await loadHistory(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/history'),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        messages: [
          { role: 'user', text: '讲一下浮力' },
          {
            role: 'assistant',
            text: '浮力等于排开液体的重量',
            thinking: '先想一下再答',
          },
        ],
      },
    });
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_owned/message');
    // Newest-first upstream; the cloud reverses so the device appends in order.
    expect(url.searchParams.get('order')).toBe('desc');
    expect(init.method).toBe('GET');
  });

  it('refuses history for a session another binding owns', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());

    const response = await loadHistory(
      request('http://localhost/api/esp32/agent/sessions/ses_other/history'),
      { params: Promise.resolve({ id: 'ses_other' }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'session_not_found' },
    });
  });

  it('assembles the answer record from the form field key', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    // The detail read is what exposes the field the options came from.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            id: 'frm_1',
            sessionID: 'ses_owned',
            title: '是否允许读取构建日志？',
            state: { status: 'pending' },
            fields: [
              {
                type: 'string',
                key: 'confirm',
                options: [
                  { value: 'yes', label: '允许' },
                  { value: 'no', label: '拒绝' },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: 'frm_1',
          answer: 'yes',
          confirmed: true,
        }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_owned/form/frm_1/reply');
    // The device sends a value; the cloud knows the field id.
    expect(JSON.parse(String(init.body))).toEqual({
      answer: { confirm: 'yes' },
    });
  });

  it('still answers by form id when the detail read fails', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ _tag: 'NotFound', message: 'gone' }), {
        status: 404,
      })
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: 'frm_1',
          answer: 'yes',
          confirmed: true,
        }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ answer: { frm_1: 'yes' } });
  });

  it('collects a multi-field form one step at a time and submits once', async () => {
    const detail = () =>
      new Response(
        JSON.stringify({
          data: {
            id: 'frm_seq',
            sessionID: 'ses_owned',
            title: 'Questions',
            state: { status: 'pending' },
            fields: [
              {
                type: 'string',
                key: 'fruit',
                title: 'Pick a fruit',
                options: [
                  { value: 'apple', label: 'Apple' },
                  { value: 'banana', label: 'Banana' },
                ],
              },
              {
                type: 'string',
                key: 'drink',
                title: 'Pick a drink',
                options: [
                  { value: 'water', label: 'Water' },
                  { value: 'tea', label: 'Tea' },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      );
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(detail());

    const first = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: 'frm_seq#0',
          answer: 'apple',
          confirmed: true,
        }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      data: { replied: true },
    });
    // A non-final step is only accumulated: v2 settles a form on its first
    // reply, so nothing may reach upstream until the last step.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Every POST re-asserts ownership, then re-reads the detail.
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(detail());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const second = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: 'frm_seq#1',
          answer: 'tea',
          confirmed: true,
        }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(second.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[4] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_owned/form/frm_seq/reply');
    // One upstream reply carries every step's answer, keyed by field id.
    expect(JSON.parse(String(init.body))).toEqual({
      answer: { fruit: 'apple', drink: 'tea' },
    });
  });

  it('treats a 409 on the final submit as already settled', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            id: 'frm_single',
            sessionID: 'ses_owned',
            state: { status: 'pending' },
            fields: [
              {
                type: 'string',
                key: 'confirm',
                options: [
                  { value: 'yes', label: '允许' },
                  { value: 'no', label: '拒绝' },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ _tag: 'Conflict', message: 'settled' }), {
        status: 409,
      })
    );

    const response = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: 'frm_single#0',
          answer: 'yes',
          confirmed: true,
        }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    // Upstream settled the form between the detail read and the reply. For a
    // user who already picked an answer that is a success, not an error.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { replied: true },
    });
  });

  it('rejects a question reply without on-device confirmation', async () => {
    const response = await replyQuestion(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question_id: 'frm_1', answer: 'yes' }),
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'confirmation_required' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interrupts a submitted run and reports what upstream said', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { interrupted: true } }), {
        status: 200,
      })
    );

    const response = await interruptRun(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/interrupt', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { interrupted: true },
    });
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_owned/interrupt');
    expect(init.method).toBe('POST');
  });

  it('reports an interrupt of a session that was not running', async () => {
    fetchMock.mockResolvedValueOnce(ownedListResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { interrupted: false } }), {
        status: 200,
      })
    );

    const response = await interruptRun(
      request('http://localhost/api/esp32/agent/sessions/ses_owned/interrupt', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'ses_owned' }) }
    );

    // Not an error: the run had already finished, which is all the device
    // needs to know to stop waiting for it.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { interrupted: false },
    });
  });
});
