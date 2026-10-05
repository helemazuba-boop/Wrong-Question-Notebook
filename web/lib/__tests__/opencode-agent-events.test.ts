import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSseResponse } from '@/lib/ai-stream';
import type { OpenCodeHistoryDetail } from '@/lib/opencode-agent-detail';
import {
  createOpenCodeRelayState,
  emitNormalizedOpenCodeEvent,
  relayOpenCodeEvents,
  type OpenCodePendingProbe,
} from '@/lib/opencode-agent-events';
import {
  __resetQuestionSequencesForTest,
  recordQuestionAnswer,
} from '@/lib/opencode-agent-question-sequence';
import type {
  OpenCodeFormState,
  OpenCodePermissionRequest,
} from '@/lib/opencode-agent-gateway';

const SESSION = 'ses_123';

/** A recording stand-in for SseWriter: the relay only emits through these. */
function createWriter() {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    frames,
    names: () => frames.map(frame => frame.event),
    emit(event: string, data: Record<string, unknown>) {
      frames.push({ event, data });
      return frames.length;
    },
    comment() {
      // Keep-alives are asserted from the wire text instead.
    },
    isClosed: () => false,
  };
}

/** A v2 SSE frame: one `data:` line carrying `{id, type, data}`. */
function v2(type: string, data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: `evt_${type}`,
    type,
    data: { sessionID: SESSION, ...data },
  })}\n\n`;
}

function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function relayText(
  frames: string[],
  options: { mode?: 'run' | 'observe'; session?: string } = {}
): Promise<string> {
  const response = createSseResponse(writer =>
    relayOpenCodeEvents({
      upstream: streamOf(frames),
      writer,
      sessionId: options.session ?? SESSION,
      mode: options.mode,
    })
  );
  return response.text();
}

function eventsOf(text: string): string[] {
  return [...text.matchAll(/^event: (.+)$/gm)].map(match => match[1].trim());
}

function payloadOf(text: string, event: string): string {
  return payloadOfAt(text, event, 0);
}

/** The payload of the nth frame named `event` (0-based). */
function payloadOfAt(text: string, event: string, index: number): string {
  // Each SSE frame is `event:`, an `id:` line, then `data:`.
  const matches = [
    ...text.matchAll(
      new RegExp(`^event: ${event}\\r?\\n(?:id: .*\\r?\\n)?data: (.+)$`, 'gm')
    ),
  ];
  return matches[index]?.[1]?.trim() ?? '';
}

function permission(
  id: string,
  action: string,
  sessionId: string = SESSION
): OpenCodePermissionRequest {
  return {
    id,
    sessionId,
    action,
    title: `${action} title`,
    preview: `${action} preview`,
  };
}

/** True when a string contains an unpaired surrogate (what `.slice` produces). */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function form(
  id: string,
  options: Array<{ value: string; label: string }>,
  status: OpenCodeFormState['status'] = '',
  sessionId: string = SESSION
): OpenCodeFormState {
  return {
    id,
    sessionId,
    title: `${id} title`,
    status,
    fields: [
      {
        fieldKey: id,
        title: `${id} title`,
        options,
        optionCount: options.length,
      },
    ],
  };
}

function multiFieldForm(
  id: string,
  fields: Array<{
    fieldKey: string;
    title: string;
    options: Array<{ value: string; label: string }>;
  }>,
  status: OpenCodeFormState['status'] = 'pending'
): OpenCodeFormState {
  return {
    id,
    sessionId: SESSION,
    title: `${id} title`,
    status,
    fields: fields.map(field => ({
      ...field,
      optionCount: field.options.length,
    })),
  };
}

type ProbeHandlers = {
  active?: (sessionId: string) => Promise<string[]>;
  children?: (sessionId: string) => Promise<string[]>;
  permissions?: (sessionId: string) => Promise<OpenCodePermissionRequest[]>;
  questions?: (sessionId: string) => Promise<OpenCodeFormState[]>;
  formDetail?: (
    sessionId: string,
    formId: string
  ) => Promise<OpenCodeFormState | null>;
  outcome?: (sessionId: string) => Promise<string>;
};

function createProbe(handlers: ProbeHandlers = {}): {
  probe: OpenCodePendingProbe;
  log: string[];
} {
  const log: string[] = [];
  const probe: OpenCodePendingProbe = {
    async activeSessions() {
      log.push('active');
      return handlers.active ? handlers.active(SESSION) : [];
    },
    async childSessions(sessionId: string) {
      log.push(`children:${sessionId}`);
      return handlers.children ? handlers.children(sessionId) : [];
    },
    async permissions(sessionId: string) {
      log.push(`permissions:${sessionId}`);
      return handlers.permissions ? handlers.permissions(sessionId) : [];
    },
    async questions(sessionId: string) {
      log.push(`questions:${sessionId}`);
      return handlers.questions ? handlers.questions(sessionId) : [];
    },
    async formDetail(sessionId: string, formId: string) {
      log.push(`formDetail:${formId}`);
      return handlers.formDetail
        ? handlers.formDetail(sessionId, formId)
        : null;
    },
    async sessionOutcome(sessionId: string) {
      log.push(`outcome:${sessionId}`);
      return handlers.outcome ? handlers.outcome(sessionId) : '';
    },
  };
  return { probe, log };
}

/**
 * Run the relay against an upstream that stays open for a while and then ends,
 * with the poll interval collapsed to a few milliseconds so a real-timer test
 * still gets a dozen poll rounds. The relay returns when the upstream closes,
 * which is what lets `response.text()` resolve without fake timers.
 */
async function runProbe(input: {
  handlers?: ProbeHandlers;
  mode?: 'run' | 'observe';
  openMs?: number;
}): Promise<{ text: string; events: string[]; log: string[] }> {
  process.env.WQN_OPENCODE_PENDING_POLL_MS = '4';
  try {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // The relay already cancelled the stream.
          }
        }, input.openMs ?? 120);
      },
      cancel() {
        // Nothing to clean up.
      },
    });
    const { probe, log } = createProbe(input.handlers);
    const response = createSseResponse(writer =>
      relayOpenCodeEvents({
        upstream,
        writer,
        sessionId: SESSION,
        mode: input.mode,
        probe,
      })
    );
    const text = await response.text();
    return { text, events: eventsOf(text), log };
  } finally {
    delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
  }
}

beforeEach(() => {
  delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
  // The sequence store is process-wide (the reply route and the relay share
  // it), so a form id reused across tests must not inherit its steps.
  __resetQuestionSequencesForTest();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
});

describe('OpenCode v2 event projection', () => {
  // Captured from the live self-hosted server (v2.0.16) during a real run:
  // one prompt that ran a shell tool and then answered. This is the only
  // end-to-end v2 stream in hand, so it is the fixture that pins the shapes
  // everything else used to guess at -- including the tool-name finding below.
  const CAPTURE_SESSION = 'ses_f28f1a3f8ffeH52sTm7T7VFOZA';
  const CAPTURE_CALL = 'call_df0222084d9b466b919a9791';

  function capture(): string {
    return readFileSync(
      join(__dirname, '__fixtures__/opencode-v2-sse-raw.txt'),
      'utf8'
    );
  }

  /**
   * The capture that reproduces symptom 4: three model rounds in one run, each
   * contributing a text part, so a device that appends into one buffer builds
   * `PART-ONE.PART-ONE.PART-TWO.PART-ONE.PART-TWO.PART-THREE.` instead of
   * showing the last round's answer.
   *
   * This is `events.txt` from a live probe, not the committed
   * `opencode-v2-sse-raw.txt` -- that one has two rounds and carries no PART
   * text at all, so it cannot show a splice. Capturing the real run is what
   * makes the AS-IS column below a measurement rather than a claim.
   */
  function partRounds(): string {
    return readFileSync(
      join(__dirname, '__fixtures__/opencode-v2-part-rounds.txt'),
      'utf8'
    );
  }

  /**
   * The device appends deltas and replaces on a full `agent.text` frame, so one
   * buffer is all it has. This records what that buffer holds after every text
   * frame, which is the shape a user actually sees: an empty entry is the clear
   * frame, so `['PART-ONE.', '', 'PART-TWO.']` means round one showed, was
   * cleared, and round two showed.
   */
  function bubblesOf(
    capture: string,
    detail: OpenCodeHistoryDetail,
    sessionId: string
  ): string[] {
    const state = createOpenCodeRelayState(detail);
    const bubbles: string[] = [];
    let buffer = '';
    const writer = {
      ...createWriter(),
      emit(event: string, data: Record<string, unknown>) {
        if (event === 'agent.text') {
          buffer = String(data.text ?? '');
          bubbles.push(buffer);
        } else if (event === 'agent.text.delta') {
          buffer += String(data.delta ?? '');
          bubbles.push(buffer);
        }
        return bubbles.length;
      },
    };
    for (const frame of capture.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (
        !String((event as { type?: string }).type ?? '').startsWith('session.')
      ) {
        continue;
      }
      emitNormalizedOpenCodeEvent(writer, event, sessionId, state);
    }
    return bubbles;
  }

  const PART_ROUNDS_SESSION = 'ses_ef468b6eeffe6m26RAGcHLoWBR';

  /**
   * `bubblesOf` for the thinking channel, on the same device model: append
   * deltas, replace on a full frame. Kept separate because the two channels have
   * independent buffers and independent staircase bugs, and a shared helper
   * would have to decide which channel it was modelling.
   */
  function thinkingBubblesOf(
    capture: string,
    detail: OpenCodeHistoryDetail,
    sessionId: string
  ): string[] {
    const state = createOpenCodeRelayState(detail);
    const bubbles: string[] = [];
    let buffer = '';
    const writer = {
      ...createWriter(),
      emit(event: string, data: Record<string, unknown>) {
        if (event === 'agent.reasoning') {
          buffer = String(data.text ?? '');
          bubbles.push(buffer);
        } else if (event === 'agent.reasoning.delta') {
          buffer += String(data.delta ?? '');
          bubbles.push(buffer);
        }
        return bubbles.length;
      },
    };
    for (const frame of capture.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (
        !String((event as { type?: string }).type ?? '').startsWith('session.')
      ) {
        continue;
      }
      emitNormalizedOpenCodeEvent(writer, event, sessionId, state);
    }
    return bubbles;
  }

  it('shows each round of a multi-round run instead of splicing them', () => {
    // Symptom 4, replayed from a real capture on every tier. AS-IS, detail 1
    // and 2 built `PART-ONE.` -> `PART-ONE.PART-TWO.` -> all three glued --
    // three rounds in one device buffer with no boundary, which is exactly the
    // `11111-tooluse-1111122222-tooluse11111222223333` shape.
    //
    // The empty entries are the clear frame, not a regression: an empty
    // `agent.text` is the device's "replace the buffer with this text" frame,
    // so round N is shown, then replaced, then round N+1 shows. Brief tier
    // already cleared, so its sequence is unchanged by the fix -- which is the
    // point of the fix: the other tiers now behave the way brief always did.
    const expected = ['PART-ONE.', '', 'PART-TWO.', '', 'PART-THREE.'];
    for (const detail of [0, 1, 2] as const) {
      expect(bubblesOf(partRounds(), detail, PART_ROUNDS_SESSION)).toEqual(
        expected
      );
    }
  });

  it('starts the thinking bubble over at a round change too', () => {
    // The same staircase on the other channel. `g_agent_thinking_text` is wiped
    // once per turn on the device, so without a reasoning clear the bubble at
    // round N holds rounds 1..N -- measured on this capture as
    // ["Run the shell command.", "Run the shell command.Output: wqn-tool-probe"],
    // i.e. round two's thinking announced round one's command as its own. It is
    // bounded by kMaxThinkingBytes rather than fixed, so it shows up as a
    // truncated, nonsensical thinking block rather than an obvious duplication.
    //
    // This capture is the one that exercises reasoning: the PART-rounds capture
    // that fixes the text channel carries no reasoning events at all, which is
    // exactly why this needed its own fixture rather than sharing that one.
    //
    // Brief and standard never render a thinking block, so they expect nothing.
    for (const detail of [0, 1] as const) {
      expect(thinkingBubblesOf(capture(), detail, CAPTURE_SESSION)).toEqual([]);
    }
    expect(thinkingBubblesOf(capture(), 2, CAPTURE_SESSION)).toEqual([
      'Run the shell command.',
      '',
      'Output: wqn-tool-probe',
    ]);
  });

  it('projects a real captured run into exactly the frames the device needs', async () => {
    const text = await relayText([capture()], {
      mode: 'run',
      session: CAPTURE_SESSION,
    });

    expect(eventsOf(text)).toEqual([
      'agent.status', // session.step.started
      'agent.reasoning.delta', // "Run the shell command."
      'agent.tool', // session.tool.called, named from tool.input.started
      'agent.tool', // session.tool.success
      'agent.status', // the second step
      'agent.reasoning', // round change: the thinking bubble starts over
      'agent.text', // round change: the answer bubble starts over
      'agent.reasoning.delta', // "Output: wqn-tool-probe"
      'agent.text.delta', // the reply
      'agent.status', // session.execution.succeeded, the terminator
    ]);
  });

  it('names the shell tool in the real capture and blocks it by call id', async () => {
    const text = await relayText([capture()], {
      mode: 'run',
      session: CAPTURE_SESSION,
    });

    expect(payloadOfAt(text, 'agent.tool', 0)).toBe(
      JSON.stringify({
        session_id: CAPTURE_SESSION,
        tool: 'shell',
        call_id: CAPTURE_CALL,
        status: 'running',
        preview: 'echo wqn-tool-probe',
      })
    );
    expect(payloadOfAt(text, 'agent.tool', 1)).toBe(
      JSON.stringify({
        session_id: CAPTURE_SESSION,
        tool: 'shell',
        call_id: CAPTURE_CALL,
        status: 'done',
        preview: 'wqn-tool-probe\r\n',
      })
    );
  });

  it('keeps reasoning out of the answer in the real capture', async () => {
    const text = await relayText([capture()], {
      mode: 'run',
      session: CAPTURE_SESSION,
    });

    // The reasoning delta is "Run the shell command."; the answer is
    // "wqn-tool-probe". Neither may appear in the other's channel.
    expect(
      JSON.parse(payloadOfAt(text, 'agent.reasoning.delta', 0)).delta
    ).toBe('Run the shell command.');
    expect(payloadOfAt(text, 'agent.text.delta', 0)).toContain(
      'wqn-tool-probe'
    );
    expect(text).not.toContain('Run the shell command.\n}');
    // The capture's text.ended carries exactly the delta it already sent, so
    // it must not be followed by a repair frame replaying the whole part.
    // The one `agent.text` frame allowed is the round-boundary clear, which is
    // empty -- an empty clear is the device's "start the answer over" frame and
    // never carries text of its own.
    const textFrames = [...text.matchAll(/^event: agent.text$/gm)];
    expect(textFrames).toHaveLength(1);
    expect(JSON.parse(payloadOfAt(text, 'agent.text', 0)).text).toBe('');
  });

  it('drops the server-wide events the capture carries', async () => {
    const text = await relayText([capture()], {
      mode: 'run',
      session: CAPTURE_SESSION,
    });

    // project/provider/model/shell/inbox/usage/tool.input frames are all in the
    // capture and none is session-scoped or in the device vocabulary, so they
    // must survive parsing without producing a frame.
    for (const event of [
      'agent.permission',
      'agent.question',
      'agent.error',
      'agent.accepted',
    ]) {
      expect(text).not.toContain(`event: ${event}`);
    }
  });

  it('survives an upstream frame larger than the relay buffer', async () => {
    // `session.tool.success` carries the tool's whole output, and a tool that
    // dumped a file produces a frame well past the buffer cap. Throwing here
    // used to end a healthy run: the device saw "事件流断开" for a run that was
    // still working.
    const huge = `data: ${JSON.stringify({
      type: 'session.tool.success',
      data: {
        sessionID: SESSION,
        id: 'call_huge',
        content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }],
      },
    })}\n\n`;

    const text = await relayText([
      huge,
      'data: {"type":"session.text.delta","data":{"sessionID":"' +
        SESSION +
        '","delta":"still here"}}\n\n',
      'data: {"type":"session.execution.succeeded","data":{"sessionID":"' +
        SESSION +
        '"}}\n\n',
    ]);

    expect(eventsOf(text)).toEqual(['agent.text.delta', 'agent.status']);
    expect(payloadOfAt(text, 'agent.text.delta', 0)).toContain('still here');
    expect(payloadOf(text, 'agent.status')).toContain('"idle"');
  });

  it('keeps a good frame that shares a chunk with an oversized one', async () => {
    // The cap must discard the frame that broke it, not the frames in front of
    // it. The trim used to run before anything was parsed, so a small frame
    // that shared a chunk -- or was left over from the previous round -- with a
    // >64 KiB frame was dropped unemitted. The run survives either way, which
    // is why the loss is invisible: the device just never sees the event.
    const before = `data: {"type":"session.text.delta","data":{"sessionID":"${SESSION}","delta":"before the flood"}}\n\n`;
    const huge = `data: ${JSON.stringify({
      type: 'session.tool.success',
      data: {
        sessionID: SESSION,
        id: 'call_huge',
        content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }],
      },
    })}\n\n`;

    const text = await relayText([
      before + huge,
      'data: {"type":"session.execution.succeeded","data":{"sessionID":"' +
        SESSION +
        '"}}\n\n',
    ]);

    expect(eventsOf(text)).toEqual(['agent.text.delta', 'agent.status']);
    expect(payloadOfAt(text, 'agent.text.delta', 0)).toContain(
      'before the flood'
    );
    expect(payloadOf(text, 'agent.status')).toContain('"idle"');
  });

  it('projects a stream whose session is not the attached one into nothing', async () => {
    await expect(relayText([capture()])).resolves.not.toContain('event: agent');
  });

  it('drops an event whose session is not the attached one', () => {
    const writer = createWriter();
    const result = emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: { sessionID: 'ses_other', delta: 'x' },
      },
      SESSION,
      createOpenCodeRelayState()
    );

    expect(result).toBe('continue');
    expect(writer.frames).toEqual([]);
  });

  it('drops an event that carries no session id at all', () => {
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        { type: 'session.execution.succeeded', data: {} },
        SESSION
      )
    ).toBe('continue');
    expect(writer.frames).toEqual([]);
  });

  it('drops an unknown event type instead of passing it through', () => {
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.some.future.event',
          data: { sessionID: SESSION, text: 'leak' },
        },
        SESSION
      )
    ).toBe('continue');
    expect(writer.frames).toEqual([]);
  });

  it('does not echo the user prompt back as the answer (P1)', async () => {
    // session.input.admitted/promoted are the user's own prompt being routed
    // into a run. v1 surfaced them as agent.text, so the answer started with
    // the question. They must reach the device as nothing at all, while the
    // assistant delta that follows them still does.
    const text = await relayText([
      v2('session.input.admitted', { text: '帮我讲解这道题' }),
      v2('session.input.promoted', { text: '帮我讲解这道题' }),
      v2('session.text.delta', {
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: '讲解如下',
      }),
    ]);

    expect(eventsOf(text)).toEqual(['agent.text.delta']);
    expect(payloadOf(text, 'agent.text.delta')).toBe(
      JSON.stringify({ session_id: SESSION, delta: '讲解如下' })
    );
    expect(text).not.toContain('帮我讲解这道题');
  });

  it('keeps reasoning out of the response text channel', async () => {
    const text = await relayText([
      v2('session.reasoning.delta', {
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: '先想',
      }),
      v2('session.text.delta', {
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: '结论',
      }),
    ]);

    expect(eventsOf(text)).toEqual([
      'agent.reasoning.delta',
      'agent.text.delta',
    ]);
    expect(payloadOf(text, 'agent.text.delta')).toBe(
      JSON.stringify({ session_id: SESSION, delta: '结论' })
    );
    expect(payloadOf(text, 'agent.reasoning.delta')).toBe(
      JSON.stringify({ session_id: SESSION, delta: '先想' })
    );
  });

  it('replays the full text when a delta was lost', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();
    const base = { assistantMessageID: 'msg_1', ordinal: 0 };

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: { sessionID: SESSION, ...base, delta: 'ab' },
      },
      SESSION,
      state
    );
    // The middle delta never arrives.
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: { sessionID: SESSION, ...base, text: 'abcd' },
      },
      SESSION,
      state
    );

    expect(writer.names()).toEqual(['agent.text.delta', 'agent.text']);
    expect(writer.frames[1].data.text).toBe('abcd');
  });

  it('stays silent when the deltas already account for the whole text', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();
    const base = { assistantMessageID: 'msg_1', ordinal: 0 };

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: { sessionID: SESSION, ...base, delta: 'abc' },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: { sessionID: SESSION, ...base, text: 'abc' },
      },
      SESSION,
      state
    );

    // A redundant agent.text would overwrite what the device is still
    // appending to.
    expect(writer.names()).toEqual(['agent.text.delta']);
  });

  it('accounts deltas per (assistantMessageID, ordinal) part', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: 'one',
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_2',
          ordinal: 0,
          text: 'two',
        },
      },
      SESSION,
      state
    );

    // Nothing was sent for the second part, so it is replayed in full. The
    // clear comes first because the round changed, then the full text follows:
    // the device must drop round one's lead-in before it replaces the buffer.
    expect(writer.names()).toEqual([
      'agent.text.delta',
      'agent.text',
      'agent.text',
    ]);
    expect(writer.frames[1].data.text).toBe('');
    expect(writer.frames[2].data.text).toBe('two');
  });

  it('repairs a lost reasoning delta the same way', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();
    const base = { assistantMessageID: 'msg_1', ordinal: 0 };

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.reasoning.delta',
        data: { sessionID: SESSION, ...base, delta: 'ab' },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.reasoning.ended',
        data: { sessionID: SESSION, ...base, text: 'abcd' },
      },
      SESSION,
      state
    );

    expect(writer.names()).toEqual([
      'agent.reasoning.delta',
      'agent.reasoning',
    ]);
    expect(writer.frames[1].data.text).toBe('abcd');
  });

  it('drops reasoning entirely below the full tier', () => {
    // Both halves are skipped together on purpose: leaving `reasoning.ended`
    // on would let its self-heal replay the whole thinking text as a single
    // `agent.reasoning` frame -- exactly what the tier exists to prevent.
    for (const detail of [0, 1] as const) {
      const state = createOpenCodeRelayState(detail);
      const writer = createWriter();
      const base = { assistantMessageID: 'msg_1', ordinal: 0 };

      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.reasoning.delta',
          data: { sessionID: SESSION, ...base, delta: '先想' },
        },
        SESSION,
        state
      );
      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.reasoning.ended',
          data: { sessionID: SESSION, ...base, text: '先想清楚' },
        },
        SESSION,
        state
      );

      expect(writer.names()).toEqual([]);
    }
  });

  it('keeps tool frames at the standard tier and drops them in brief', () => {
    const standard = createOpenCodeRelayState(1);
    const standardWriter = createWriter();
    emitNormalizedOpenCodeEvent(
      standardWriter,
      {
        type: 'session.tool.called',
        data: {
          sessionID: SESSION,
          name: 'bash',
          input: { command: 'ls -la' },
        },
      },
      SESSION,
      standard
    );
    expect(standardWriter.names()).toEqual(['agent.tool']);

    const brief = createOpenCodeRelayState(0);
    const briefWriter = createWriter();
    for (const type of [
      'session.tool.called',
      'session.tool.success',
      'session.tool.failed',
    ]) {
      emitNormalizedOpenCodeEvent(
        briefWriter,
        {
          type,
          data: {
            sessionID: SESSION,
            name: 'bash',
            input: { command: 'ls -la' },
            content: [{ type: 'text', text: 'a.txt' }],
            error: { message: 'exit 1' },
          },
        },
        SESSION,
        brief
      );
    }
    expect(briefWriter.names()).toEqual([]);
  });

  it('streams the answer at every tier', () => {
    // The tier shapes the machinery, never the answer: deltas and the final
    // text must survive brief and standard untouched.
    for (const detail of [0, 1, 2] as const) {
      const state = createOpenCodeRelayState(detail);
      const writer = createWriter();
      const base = { assistantMessageID: 'msg_1', ordinal: 0 };

      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.text.delta',
          data: { sessionID: SESSION, ...base, delta: '结论' },
        },
        SESSION,
        state
      );
      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.text.ended',
          data: { sessionID: SESSION, ...base, text: '结论。' },
        },
        SESSION,
        state
      );

      expect(writer.names()).toEqual(['agent.text.delta', 'agent.text']);
    }
  });

  it('clears the device buffer when a new round starts in brief', () => {
    // One turn is several assistant rounds and only the last one is the answer.
    // The device appends deltas into a single buffer, so the brief tier clears
    // it when a new round's text starts -- otherwise every round's lead-in
    // ("让我看看：") stays glued in front of the answer.
    const state = createOpenCodeRelayState(0);
    const writer = createWriter();
    const delta = (messageId: string, text: string) => ({
      type: 'session.text.delta',
      data: {
        sessionID: SESSION,
        assistantMessageID: messageId,
        ordinal: 0,
        delta: text,
      },
    });

    emitNormalizedOpenCodeEvent(
      writer,
      delta('msg_1', '让我看看：'),
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      delta('msg_2', '答案在此'),
      SESSION,
      state
    );

    expect(writer.names()).toEqual([
      'agent.text.delta',
      'agent.text',
      'agent.text.delta',
    ]);
    expect(writer.frames[1].data.text).toBe('');
    expect(writer.frames[2].data.delta).toBe('答案在此');
  });

  it('clears the device buffer at a round change on every tier', () => {
    // This is the regression test for the `11111-tooluse-1111122222-tooluse…`
    // splice. It used to be named "leaves the device buffer alone at the
    // standard and full tiers" and asserted exactly two delta frames with no
    // clear between them -- which is the bug, stated as an expectation. Two
    // rounds, one device buffer, no boundary: the second round's lead-in was
    // glued in front of the answer on every tier except brief.
    for (const detail of [0, 1, 2] as const) {
      const state = createOpenCodeRelayState(detail);
      const writer = createWriter();
      const delta = (messageId: string, text: string) => ({
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: messageId,
          ordinal: 0,
          delta: text,
        },
      });

      emitNormalizedOpenCodeEvent(
        writer,
        delta('msg_1', '让我看看：'),
        SESSION,
        state
      );
      emitNormalizedOpenCodeEvent(
        writer,
        delta('msg_2', '答案在此'),
        SESSION,
        state
      );

      // The clear is an EMPTY agent.text: the device's existing "replace the
      // buffer with this text" frame, so the boundary costs no extra state on
      // the firmware side and never blanks a block that is already mirrored.
      expect(writer.names()).toEqual([
        'agent.text.delta',
        'agent.text',
        'agent.text.delta',
      ]);
      expect(writer.frames[1].data.text).toBe('');
    }
  });

  it('does not replay a superseded round when its end arrives late in brief', () => {
    const state = createOpenCodeRelayState(0);
    const writer = createWriter();

    // Round 1's deltas are cut short (2 of 5 characters), so its `ended` would
    // normally self-heal by replaying the whole part.
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: '让我',
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_2',
          ordinal: 0,
          delta: '答案在此',
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          text: '让我看看：',
        },
      },
      SESSION,
      state
    );

    // The bubble has moved on to round 2; replaying round 1 would glue it back
    // in front of the answer.
    expect(writer.names()).toEqual([
      'agent.text.delta',
      'agent.text',
      'agent.text.delta',
    ]);
  });

  it('still shows a round whose deltas never arrived in brief', () => {
    const state = createOpenCodeRelayState(0);
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: '开头',
        },
      },
      SESSION,
      state
    );
    // Round 2 produced text but no delta reached the relay: its `ended` is the
    // only copy, so it becomes the current round (reset, then the full text).
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_2',
          ordinal: 0,
          text: '答案在此',
        },
      },
      SESSION,
      state
    );

    expect(writer.names()).toEqual([
      'agent.text.delta',
      'agent.text',
      'agent.text',
    ]);
    expect(writer.frames[1].data.text).toBe('');
    expect(writer.frames[2].data.text).toBe('答案在此');
  });

  it('clips a single delta to the device budget', () => {
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: 'x'.repeat(4096),
        },
      },
      SESSION
    );

    expect(String(writer.frames[0].data.delta)).toHaveLength(2048);
  });

  it('bounds CJK text and deltas by UTF-8 bytes, not UTF-16 units', () => {
    // One Chinese character is three UTF-8 bytes but one UTF-16 unit, so a
    // `.slice(0, 8192)` sent 3x the firmware's `text_event_bytes` buffer. The
    // projected text must fit the manifest bound in bytes instead.
    const state = createOpenCodeRelayState();
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.ended',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          text: '汉'.repeat(4000),
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: '汉'.repeat(2000),
        },
      },
      SESSION,
      state
    );

    const text = String(writer.frames[0].data.text);
    const delta = String(writer.frames[1].data.delta);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(text).toHaveLength(2730); // floor(8192 / 3) whole characters
    expect(Buffer.byteLength(delta, 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(delta).toHaveLength(682); // floor(2048 / 3)
  });

  it('never emits a lone surrogate when a byte bound cuts an emoji', () => {
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.text.delta',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          delta: '😀'.repeat(600), // 2400 bytes, over the 2048 delta budget
        },
      },
      SESSION
    );

    const delta = String(writer.frames[0].data.delta);
    expect(delta).toBe('😀'.repeat(512)); // 2048 / 4, no partial pair
    expect(hasLoneSurrogate(delta)).toBe(false);
  });

  it('bounds reasoning by bytes at the full tier', () => {
    const state = createOpenCodeRelayState(2);
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.reasoning.ended',
        data: {
          sessionID: SESSION,
          assistantMessageID: 'msg_1',
          ordinal: 0,
          text: '汉'.repeat(2000),
        },
      },
      SESSION,
      state
    );

    const frame = writer.frames[0];
    expect(frame.event).toBe('agent.reasoning');
    expect(
      Buffer.byteLength(String(frame.data.text), 'utf8')
    ).toBeLessThanOrEqual(2 * 1024);
  });

  it('clamps short projected fields by code points, never splitting a pair', () => {
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.called',
        data: {
          sessionID: SESSION,
          id: 'call_1',
          name: '😀'.repeat(100),
          input: { command: '😀'.repeat(200) },
        },
      },
      SESSION
    );

    const frame = writer.frames[0];
    expect(frame.data.tool).toBe('😀'.repeat(80));
    expect(frame.data.preview).toBe('😀'.repeat(160));
    expect(hasLoneSurrogate(String(frame.data.tool))).toBe(false);
    expect(hasLoneSurrogate(String(frame.data.preview))).toBe(false);
  });

  it('projects tool called/success/failed with their own previews', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.called',
        data: {
          sessionID: SESSION,
          name: 'bash',
          input: { command: 'ls -la' },
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.success',
        data: {
          sessionID: SESSION,
          name: 'bash',
          content: [{ type: 'text', text: 'a.txt' }],
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.failed',
        data: {
          sessionID: SESSION,
          name: 'bash',
          error: { message: 'exit 1' },
        },
      },
      SESSION,
      state
    );

    expect(writer.frames).toEqual([
      {
        event: 'agent.tool',
        data: {
          session_id: SESSION,
          tool: 'bash',
          status: 'running',
          preview: 'ls -la',
        },
      },
      {
        event: 'agent.tool',
        data: {
          session_id: SESSION,
          tool: 'bash',
          status: 'done',
          preview: 'a.txt',
        },
      },
      {
        event: 'agent.tool',
        data: {
          session_id: SESSION,
          tool: 'bash',
          status: 'error',
          preview: 'exit 1',
        },
      },
    ]);
  });

  it('drops the shell events, which are not session-scoped', () => {
    // The upstream names are `shell.created` / `shell.exited`, and neither
    // carries a session id (`shell.exited` has only {id, exit, status}), so
    // neither can be projected onto one device's stream without inventing a
    // correlation. The shell tool already shows up as `session.tool.*` under
    // its real name, so these frames add nothing. Asserted so a future rename
    // of the upstream names cannot silently resurrect the old fake mapping.
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'shell.created',
        data: {
          info: {
            id: 'sh_1',
            command: 'make',
            metadata: { sessionID: SESSION },
          },
        },
      },
      SESSION
    );
    emitNormalizedOpenCodeEvent(
      writer,
      { type: 'shell.exited', data: { id: 'sh_1', exit: 1, status: 'exited' } },
      SESSION
    );

    expect(writer.frames).toEqual([]);
  });

  it('labels a tool from the call id, since only input.started carries a name', () => {
    // Real shape: `called`/`success`/`failed` carry `{id}` and no `name`.
    const writer = createWriter();
    const state = createOpenCodeRelayState();

    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.input.started',
        data: { sessionID: SESSION, id: 'call_1', name: 'shell' },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.called',
        data: { sessionID: SESSION, id: 'call_1', input: { command: 'make' } },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.success',
        data: {
          sessionID: SESSION,
          id: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
      SESSION,
      state
    );

    expect(writer.frames).toEqual([
      {
        event: 'agent.tool',
        data: {
          session_id: SESSION,
          tool: 'shell',
          call_id: 'call_1',
          status: 'running',
          preview: 'make',
        },
      },
      {
        event: 'agent.tool',
        data: {
          session_id: SESSION,
          tool: 'shell',
          call_id: 'call_1',
          status: 'done',
          preview: 'ok',
        },
      },
    ]);
  });

  it('keeps a name it never learned from labelling every tool "tool"', () => {
    const writer = createWriter();
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.tool.called',
        data: { sessionID: SESSION, id: 'call_9' },
      },
      SESSION
    );
    expect(writer.frames[0].data).toMatchObject({
      tool: 'tool',
      call_id: 'call_9',
    });
  });

  it('maps a successful run to the idle terminator and closes', () => {
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
        SESSION
      )
    ).toBe('complete');
    expect(writer.frames).toEqual([
      { event: 'agent.status', data: { session_id: SESSION, status: 'idle' } },
    ]);
  });

  it('reports a failed run as an error and still terminates', async () => {
    const text = await relayText([
      v2('session.execution.failed', { error: { message: 'provider quota' } }),
    ]);

    expect(eventsOf(text)).toEqual(['agent.error', 'agent.status']);
    // The error frame comes first: the device renders the terminator, so an
    // error after it would be lost.
    expect(payloadOf(text, 'agent.error')).toBe(
      JSON.stringify({ session_id: SESSION, message: 'provider quota' })
    );
    expect(payloadOf(text, 'agent.status')).toBe(
      JSON.stringify({ session_id: SESSION, status: 'idle' })
    );
  });

  it('never reports an interrupted run as a success', () => {
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        { type: 'session.execution.interrupted', data: { sessionID: SESSION } },
        SESSION
      )
    ).toBe('complete');
    expect(writer.frames).toEqual([
      {
        event: 'agent.error',
        data: { session_id: SESSION, message: '执行已中止' },
      },
      { event: 'agent.status', data: { session_id: SESSION, status: 'idle' } },
    ]);
  });

  it('reports a failed step without ending the run', () => {
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        {
          type: 'session.step.failed',
          data: { sessionID: SESSION, error: { message: 'step blew up' } },
        },
        SESSION
      )
    ).toBe('activity');
    expect(writer.frames).toEqual([
      {
        event: 'agent.error',
        data: {
          session_id: SESSION,
          message: 'step blew up',
          // Without this the device treats the step failure as terminal, marks
          // the run failed and closes every later tool block as an error.
          fatal: false,
        },
      },
    ]);
  });

  it('marks retryable step failures and leaves terminal errors unmarked', () => {
    // `agent.error.fatal` is absent-or-true. The two session-scoped errors that
    // really end the run therefore stay unmarked, and only the one the upstream
    // will retry carries `fatal: false` -- the distinction is the whole point of
    // the field, so pin both sides rather than only the retryable one.
    const writer = createWriter();

    for (const type of [
      'session.execution.failed',
      'session.execution.interrupted',
    ]) {
      emitNormalizedOpenCodeEvent(
        writer,
        { type, data: { sessionID: SESSION } },
        SESSION
      );
    }
    const terminalErrors = writer.frames.filter(
      frame => frame.event === 'agent.error'
    );
    expect(terminalErrors).toHaveLength(2);
    for (const frame of terminalErrors) {
      expect(frame.data).not.toHaveProperty('fatal');
    }
  });

  it('ends the stream when the server disposes, even without a session id', () => {
    // `global.disposed` is the one event that is server-wide by definition: it
    // carries no session id, so the session filter would drop it and the device
    // would sit out its absolute cap against a server that no longer exists.
    const writer = createWriter();

    expect(
      emitNormalizedOpenCodeEvent(
        writer,
        { type: 'global.disposed', data: {} },
        SESSION
      )
    ).toBe('complete');
    expect(writer.frames).toEqual([
      {
        event: 'agent.error',
        data: { session_id: SESSION, message: 'OpenCode 服务已断开' },
      },
      { event: 'agent.status', data: { session_id: SESSION, status: 'idle' } },
    ]);
  });

  it('stops projecting a disposed server instead of reading on', async () => {
    const text = await relayText([
      'data: {"id":"evt_d","type":"global.disposed","data":{}}\n\n',
      // A frame after the disposal must never reach the device: the relay has
      // already returned, so the device stream is closed with the terminator.
      v2('session.text.delta', {
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: 'too late',
      }),
    ]);

    expect(eventsOf(text)).toEqual(['agent.error', 'agent.status']);
  });

  it('fills the long tool gap and the retry/compaction windows with status', () => {
    const state = createOpenCodeRelayState();
    const writer = createWriter();

    emitNormalizedOpenCodeEvent(
      writer,
      { type: 'session.step.started', data: { sessionID: SESSION } },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      {
        type: 'session.retry.scheduled',
        data: {
          sessionID: SESSION,
          attempt: 2,
          error: { message: 'rate limited' },
        },
      },
      SESSION,
      state
    );
    emitNormalizedOpenCodeEvent(
      writer,
      { type: 'session.compaction.started', data: { sessionID: SESSION } },
      SESSION,
      state
    );

    expect(writer.frames).toEqual([
      {
        event: 'agent.status',
        data: {
          session_id: SESSION,
          status: 'busy',
          message: 'Agent 执行中',
        },
      },
      {
        event: 'agent.status',
        data: {
          session_id: SESSION,
          status: 'retry',
          attempt: 2,
          message: 'rate limited',
        },
      },
      {
        event: 'agent.status',
        data: {
          session_id: SESSION,
          status: 'busy',
          message: '正在压缩上下文',
        },
      },
    ]);
  });
});

describe('OpenCode v2 pending-ask delivery', () => {
  it('emits a keepalive comment while the upstream stays silent', async () => {
    vi.useFakeTimers();
    try {
      const response = createSseResponse(writer =>
        relayOpenCodeEvents({
          upstream: new ReadableStream<Uint8Array>({
            cancel() {
              // The relay cancels on exit; nothing to clean up.
            },
          }),
          writer,
          sessionId: SESSION,
        })
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      await vi.advanceTimersByTimeAsync(0);
      // Heartbeat every 7 poll ticks, so 7 x 2s is the first comment.
      await vi.advanceTimersByTimeAsync(2000 * 7);
      const { value } = await reader.read();
      expect(decoder.decode(value)).toContain(': keepalive');

      await reader.cancel().catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects permission fields off the Permission.Request shape', async () => {
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        permissions: async () => [permission('per_1', 'bash')],
      },
    });

    // First poll round only: the relay stops reading the list once the device
    // has one ask armed, so later rounds are empty on purpose.
    expect(log.slice(0, 3)).toEqual([
      'active',
      `children:${SESSION}`,
      `permissions:${SESSION}`,
    ]);
    expect(payloadOf(text, 'agent.permission')).toBe(
      JSON.stringify({
        session_id: SESSION,
        permission_id: 'per_1',
        type: 'bash',
        title: 'bash title',
        preview: 'bash preview',
      })
    );
  });

  it('clamps an over-long astral permission to the schema bounds', async () => {
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        permissions: async () => [
          {
            ...permission('per_1', 'bash'),
            action: '😀'.repeat(100), // schema: 80 code points
            title: '😀'.repeat(200), // schema: 160 code points
          },
        ],
      },
    });

    const payload = JSON.parse(payloadOf(text, 'agent.permission')) as {
      type: string;
      title: string;
    };
    expect(payload.type).toBe('😀'.repeat(80));
    expect(payload.title).toBe('😀'.repeat(160));
    expect(hasLoneSurrogate(payload.type)).toBe(false);
    expect(hasLoneSurrogate(payload.title)).toBe(false);
  });

  it('clamps an over-long astral question title to the schema bound', async () => {
    const wide = form('frm_1', [{ value: 'yes', label: 'Yes' }]);
    // The projected title is the FIELD title (the form title is a constant
    // like "Questions"), so that is what the clamp has to hold for.
    wide.fields[0].title = '😀'.repeat(200); // schema: 160 code points
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => [wide],
      },
    });

    const payload = JSON.parse(payloadOf(text, 'agent.question')) as {
      title: string;
    };
    expect(payload.title).toBe('😀'.repeat(160));
    expect(hasLoneSurrogate(payload.title)).toBe(false);
  });

  it('emits the same ask once across many poll rounds', async () => {
    let rounds = 0;
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        // The ask only appears on the second round, and then stays: every
        // later round must see it as already delivered.
        permissions: async () =>
          rounds++ === 0 ? [] : [permission('per_1', 'bash')],
      },
    });

    expect(
      log.filter(entry => entry === `permissions:${SESSION}`).length
    ).toBeGreaterThan(1);
    expect(text.match(/event: agent.permission/g)).toHaveLength(1);
  });

  it('holds the second ask until the first is answered (single slot)', async () => {
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        permissions: async () => [
          permission('per_1', 'bash'),
          permission('per_2', 'edit'),
        ],
      },
    });

    // The device holds one pending permission id, so the second ask would
    // overwrite the first instead of stacking.
    expect(payloadOf(text, 'agent.permission')).toContain('"per_1"');
    expect(text).not.toContain('"per_2"');
  });

  it('emits nothing once the session is no longer running (gate 1)', async () => {
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [],
        permissions: async () => [permission('per_1', 'bash')],
      },
    });

    expect(log.filter(entry => entry === 'active').length).toBeGreaterThan(2);
    expect(text).not.toContain('agent.permission');
    // Gate 1 short-circuits before any per-session read is spent.
    expect(log).not.toContain(`permissions:${SESSION}`);
  });

  it('discovers asks raised by a subagent session', async () => {
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        children: async () => ['ses_child'],
        permissions: async sessionId =>
          sessionId === 'ses_child' ? [permission('per_child', 'bash')] : [],
      },
    });

    expect(log).toContain(`children:${SESSION}`);
    expect(log).toContain('permissions:ses_child');
    // The device replies against the session that actually raised the ask.
    expect(payloadOf(text, 'agent.permission')).toBe(
      JSON.stringify({
        session_id: 'ses_child',
        permission_id: 'per_child',
        type: 'bash',
        title: 'bash title',
        preview: 'bash preview',
      })
    );
  });

  it('carries the subagent session on a subagent question too', async () => {
    const childOption = [{ value: 'a', label: '甲' }];
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        children: async () => ['ses_child'],
        questions: async sessionId =>
          sessionId === 'ses_child' ? [form('frm_child', childOption)] : [],
        formDetail: async (_sessionId, formId) =>
          form(formId, childOption, 'pending'),
      },
    });

    expect(log).toContain('questions:ses_child');
    expect(log).toContain('formDetail:frm_child');
    // The permission and question routes are both session-scoped upstream, so
    // an ask is answered on the session that raised it. Attributing only the
    // permission left a subagent's question discoverable but never answerable:
    // the reply landed on the attached session and 404'd.
    expect(payloadOf(text, 'agent.question')).toBe(
      JSON.stringify({
        session_id: 'ses_child',
        question_id: 'frm_child#0',
        title: 'frm_child title',
        options: [{ value: 'a', label: '甲' }],
      })
    );
  });

  it('does not re-arm a form the user already answered (gate 3)', async () => {
    const { text, log } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        // Form.Info has no state, so only the detail read can tell the relay
        // that this form is resolved. Without it a re-attach would re-arm it.
        questions: async () => [form('frm_1', [{ value: 'a', label: 'A' }])],
        formDetail: async () =>
          form('frm_1', [{ value: 'a', label: 'A' }], 'answered'),
      },
    });

    expect(log).toContain('formDetail:frm_1');
    expect(text).not.toContain('agent.question');
  });

  it('projects a pending form onto its options with a step id', async () => {
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => [
          form('frm_1', [
            { value: 'a', label: '甲' },
            { value: 'b', label: '乙' },
          ]),
        ],
        formDetail: async () =>
          form('frm_1', [
            { value: 'a', label: '甲' },
            { value: 'b', label: '乙' },
          ]),
      },
    });

    expect(payloadOf(text, 'agent.question')).toBe(
      JSON.stringify({
        session_id: SESSION,
        question_id: 'frm_1#0',
        title: 'frm_1 title',
        options: [
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙' },
        ],
      })
    );
  });

  it('projects a wide form onto every option, up to the cap', async () => {
    const options = Array.from({ length: 5 }, (_, i) => ({
      value: `o${i}`,
      label: `Option ${i}`,
    }));
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => [form('frm_wide', options, 'pending')],
      },
    });

    const payload = JSON.parse(payloadOf(text, 'agent.question')) as {
      question_id: string;
      options: unknown[];
    };
    expect(payload.question_id).toBe('frm_wide#0');
    expect(payload.options).toHaveLength(5);
  });

  it('degrades an over-cap form to an abort-only ask', async () => {
    const options = Array.from({ length: 9 }, (_, i) => ({
      value: `o${i}`,
      label: `Option ${i}`,
    }));
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => [form('frm_huge', options, 'pending')],
      },
    });

    // Still an ask, never a silent status: the device shows the title with
    // its abort entry, which is the only action such a field allows.
    const payload = JSON.parse(payloadOf(text, 'agent.question')) as {
      question_id: string;
      options: unknown[];
    };
    expect(payload.question_id).toBe('frm_huge#0');
    expect(payload.options).toEqual([]);
  });

  it('arms an unanswerable form as an abort-only ask', async () => {
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => [form('frm_text', [], 'pending')],
      },
    });

    // The ask must reach the device even when no option can be projected:
    // the device shows the title plus its abort entry, so the run is never
    // blocked behind a prompt the user cannot see.
    const payload = JSON.parse(payloadOf(text, 'agent.question')) as {
      question_id: string;
      options: unknown[];
    };
    expect(payload.question_id).toBe('frm_text#0');
    expect(payload.options).toEqual([]);
  });

  it('advances a multi-field form one step per recorded answer', async () => {
    const two = multiFieldForm('frm_seq', [
      {
        fieldKey: 'q0',
        title: 'Pick a fruit',
        options: [{ value: 'apple', label: 'Apple' }],
      },
      {
        fieldKey: 'q1',
        title: 'Pick a drink',
        options: [{ value: 'water', label: 'Water' }],
      },
    ]);
    let polls = 0;
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        questions: async () => {
          polls += 1;
          // The reply route records between polls; emulate it once the first
          // step has certainly gone out.
          if (polls === 3) {
            recordQuestionAnswer({
              sessionId: SESSION,
              formId: 'frm_seq',
              step: 0,
              answer: 'apple',
            });
          }
          return [two];
        },
      },
    });

    expect(payloadOfAt(text, 'agent.question', 0)).toContain('"frm_seq#0"');
    expect(payloadOfAt(text, 'agent.question', 0)).toContain('Pick a fruit');
    expect(payloadOfAt(text, 'agent.question', 1)).toContain('"frm_seq#1"');
    expect(payloadOfAt(text, 'agent.question', 1)).toContain('Pick a drink');
  });

  it('arms only one ask, so a form never lands on top of a permission', async () => {
    // The device has one option bar and one pending-ask string, so a question
    // delivered while a permission is live is dropped by the firmware and the
    // run blocks behind it. The relay must not emit both in the first place.
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        permissions: async () => [permission('prm_1', 'write file')],
        questions: async () => [
          form('frm_1', [{ value: 'math', label: '数学错题本' }], 'pending'),
        ],
      },
    });

    expect(text).toContain('agent.permission');
    expect(text).not.toContain('agent.question');
    expect(payloadOf(text, 'agent.permission')).toContain('prm_1');
  });

  it('frees the slot for the next ask once one is answered', async () => {
    // A run raises one permission after another. The ask leaves the upstream
    // queue when it is answered, and that has to release the device's slot --
    // otherwise every ask after the first is dropped and the run stalls.
    let rounds = 0;
    const { text } = await runProbe({
      handlers: {
        active: async () => [SESSION],
        permissions: async () =>
          rounds++ < 2 ? [permission('prm_1', 'bash')] : [],
        questions: async () =>
          rounds < 4
            ? []
            : [form('frm_1', [{ value: 'a', label: 'A' }], 'pending')],
      },
    });

    expect(payloadOf(text, 'agent.permission')).toContain('"prm_1"');
    expect(payloadOf(text, 'agent.question')).toContain('"frm_1#0"');
  });

  it('frees the bar for a later ask once a QUESTION is answered', async () => {
    // The permission half of the single slot had its own release check; the
    // question half sat behind an early return that a live question always
    // took, so the very first question of a run held the bar for the rest of
    // it and every ask after it was dropped -- the run stalled until the stream
    // timed out. Same slot, same rule, both directions.
    let round = 0;
    const { text } = await runProbe({
      handlers: {
        active: async () => {
          round += 1;
          return [SESSION];
        },
        children: async () => [],
        permissions: async () =>
          round > 3 ? [permission('prm_late', 'bash')] : [],
        questions: async () =>
          round <= 3
            ? [form('frm_1', [{ value: 'a', label: 'A' }], 'pending')]
            : [],
      },
    });

    expect(payloadOf(text, 'agent.question')).toContain('"frm_1#0"');
    // The later permission only reaches the device if answering the question
    // released the bar, so this is the whole assertion.
    expect(payloadOf(text, 'agent.permission')).toContain('"prm_late"');
  });

  it('does not clear a subagent permission against the parent queue', async () => {
    // A pending ask belongs to the session that raised it, so its liveness is
    // that session's queue and nothing else. Judging it against whichever
    // target the loop happened to be on freed the bar while a subagent's
    // permission was still live, and the next ask landed on top of a permission
    // nobody had answered -- the duplicate of the bug above, from the other
    // direction.
    let round = 0;
    const child = 'ses_child';
    const { text } = await runProbe({
      handlers: {
        active: async () => {
          round += 1;
          return [SESSION, child];
        },
        children: async () => [child],
        permissions: async sessionId =>
          sessionId === child ? [permission('prm_child', 'bash', child)] : [],
        // Only offered once the permission is armed, so this is exactly the
        // round in which a wrongly-cleared slot would let it through.
        questions: async () =>
          round >= 3
            ? [form('frm_1', [{ value: 'a', label: 'A' }], 'pending')]
            : [],
      },
    });

    expect(payloadOf(text, 'agent.permission')).toContain('"prm_child"');
    expect(payloadOf(text, 'agent.permission')).toContain(`"${child}"`);
    expect(text).not.toContain('agent.question');
  });

  it('ends an observe attach once a finished run reports its outcome', async () => {
    const { text, log } = await runProbe({
      mode: 'observe',
      handlers: {
        active: async () => [],
        outcome: async () => 'succeeded',
      },
    });

    // Both gates read the active map: the poll round to decide whether a run
    // can be waiting on an ask, and the observe round to decide whether it is
    // over.
    expect(log).toEqual(['active', 'active', `outcome:${SESSION}`]);
    expect(text.match(/event: agent.status/g)).toHaveLength(1);
    expect(payloadOf(text, 'agent.status')).toBe(
      JSON.stringify({ session_id: SESSION, status: 'idle' })
    );
  });

  it('keeps an idle session attached while it has no outcome', async () => {
    const { text, log } = await runProbe({
      mode: 'observe',
      handlers: {
        // An outcomeless session is idle, not finished: no terminator.
        active: async () => [],
        outcome: async () => '',
      },
    });

    expect(log).toContain('active');
    expect(text).not.toContain('agent.status');
  });

  it('never uses the outcome check in run mode', async () => {
    const { text, log } = await runProbe({
      mode: 'run',
      handlers: {
        // A run may legitimately be silent for minutes, so the outcome probe
        // would terminate a live run that has not produced text yet.
        active: async () => [],
        outcome: async () => 'succeeded',
      },
    });

    expect(log.filter(entry => entry === 'active').length).toBeGreaterThan(2);
    expect(log).not.toContain(`outcome:${SESSION}`);
    expect(text).not.toContain('"status":"idle"');
  });

  it('survives a failing poll round without dropping the stream', async () => {
    process.env.WQN_OPENCODE_PENDING_POLL_MS = '4';
    try {
      const probe: OpenCodePendingProbe = {
        activeSessions: async () => {
          throw new Error('upstream unavailable');
        },
        childSessions: async () => [],
        permissions: async () => [],
        questions: async () => [],
        formDetail: async () => null,
        sessionOutcome: async () => '',
      };
      const response = createSseResponse(writer =>
        relayOpenCodeEvents({
          upstream: streamOf([
            v2('session.text.delta', {
              assistantMessageID: 'msg_1',
              ordinal: 0,
              delta: 'still here',
            }),
          ]),
          writer,
          sessionId: SESSION,
          probe,
        })
      );

      // The upstream chunk that arrived while the poll was failing is still
      // relayed once the poll failure has been swallowed.
      await expect(response.text()).resolves.toContain('"delta":"still here"');
    } finally {
      delete process.env.WQN_OPENCODE_PENDING_POLL_MS;
    }
  });
});
