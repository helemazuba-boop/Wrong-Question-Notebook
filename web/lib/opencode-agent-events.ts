import type { SseWriter } from '@/lib/ai-stream';

/** The permission shape this projection needs; the gateway produces it. */
export interface OpenCodePendingAsk {
  id: string;
  sessionId: string;
  action: string;
  title: string;
  preview: string;
}

/** The form shape this projection needs; the gateway produces it. */
export interface OpenCodePendingQuestion {
  id: string;
  /** Empty for `Form.Info`; only `Form.Detail` carries a resolved state. */
  status: string;
  title: string;
  options: Array<{ value: string; label: string }>;
  /** Raw option count, before the two-slot device cap. */
  optionCount: number;
}

/**
 * Projection of OpenCode v2 upstream events onto the device event vocabulary.
 *
 * The device contract (`agent.*`) is unchanged by the v2 migration; everything
 * v2 invents is translated here. Two shapes change upstream:
 *
 *  - the SSE envelope moved from `event.properties.*` to `event.data.*`, and the
 *    owning session id moved with it. There is no `payload` wrapper.
 *  - the v1 vocabulary (`session.status`, `message.part.*`, `permission.asked`)
 *    is gone. v2 splits user input, assistant text and reasoning into three
 *    separate event families, which is what makes P1 (the gateway echoing the
 *    user's own prompt back as the answer) structurally impossible.
 *
 * Everything below is a whitelist: an upstream event that is not named here is
 * dropped, never passed through. Shapes come from `__fixtures__/
 * opencode-v2-sse-raw.txt`, a complete run captured from the live server: it
 * pins the tool, text, reasoning, step and execution families. Branches it does
 * not cover (permission, form, interrupt, step failure, compaction) stay marked
 * `[v2-unverified]` until a capture reaches them.
 */

const MAX_UPSTREAM_FRAME_CHARS = 64 * 1024;
const MAX_TEXT_EVENT_CHARS = 8 * 1024;
const MAX_DELTA_EVENT_CHARS = 2 * 1024;
const MAX_REASONING_EVENT_CHARS = 2 * 1024;
const MAX_STATUS_MESSAGE_CHARS = 240;

/**
 * Device-visible option bar has exactly two slots; a third would collide with
 * the key-hint strip. The cloud caps the list, so more options never render.
 */
const MAX_QUESTION_OPTIONS = 2;

/** Pending-ask polling cadence. */
const DEFAULT_PENDING_POLL_INTERVAL_MS = 2000;
// Heartbeat every 7 ticks = 14s: under the 15s proxy reap window that made the
// v1 fixed sleep necessary, while keeping one timer for both concerns.
const HEARTBEAT_EVERY_N_TICKS = 7;

function pendingPollIntervalMs(): number {
  const configured = Number(
    process.env.WQN_OPENCODE_PENDING_POLL_MS || DEFAULT_PENDING_POLL_INTERVAL_MS
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PENDING_POLL_INTERVAL_MS;
}

interface OpenCodeEvent {
  type?: string;
  data?: Record<string, unknown>;
}

/**
 * Per-attach relay state. Passing it in (rather than keeping it in module
 * scope) keeps two concurrent attaches from sharing dedupe sets, which would
 * silently drop an ask on one of them.
 */
export interface OpenCodeRelayState {
  /** Permission ids already projected during this attach. */
  seenPermissions: Set<string>;
  /** Form ids already projected during this attach. */
  seenQuestions: Set<string>;
  /**
   * (assistantMessageID, ordinal) -> characters of `agent.text.delta` already
   * sent. This is the only record of what the device actually received, so
   * `session.text.ended` can tell a complete stream from a truncated one.
   */
  textDeltas: Map<string, number>;
  /** Same accounting for `agent.reasoning.delta`. */
  reasoningDeltas: Map<string, number>;
  /**
   * Tool call id -> tool name. Upstream `session.tool.called/.success/.failed`
   * carry only the call id; the name lives in `session.tool.input.started`.
   * Without this the device would label every block "tool" and merge them all.
   */
  toolNames: Map<string, string>;
  /**
   * The device holds one pending-ask string, period -- permission and question
   * share a single option bar. A live ask of either kind therefore blocks a new
   * ask of the other: the firmware drops what does not fit, and the poller
   * re-discovers it once the running one is answered.
   */
  pendingPermissionId: string | null;
  pendingQuestionId: string | null;
}

export function createOpenCodeRelayState(): OpenCodeRelayState {
  return {
    seenPermissions: new Set<string>(),
    seenQuestions: new Set<string>(),
    textDeltas: new Map<string, number>(),
    reasoningDeltas: new Map<string, number>(),
    toolNames: new Map<string, string>(),
    pendingPermissionId: null,
    pendingQuestionId: null,
  };
}

/**
 * The upstream reads the relay needs in order to discover asks. Injected
 * rather than imported so the relay stays free of HTTP concerns (and so the
 * routes remain the single place that knows how a binding is resolved).
 */
export interface OpenCodePendingProbe {
  activeSessions(): Promise<string[]>;
  childSessions(sessionId: string): Promise<string[]>;
  permissions(sessionId: string): Promise<OpenCodePendingAsk[]>;
  questions(sessionId: string): Promise<OpenCodePendingQuestion[]>;
  formDetail(
    sessionId: string,
    formId: string
  ): Promise<OpenCodePendingQuestion | null>;
  sessionOutcome(sessionId: string): Promise<string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  object: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function numberField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function previewValue(value: unknown, max = 160): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of ['command', 'path', 'file', 'description', 'pattern']) {
    const field = object[key];
    if (typeof field === 'string' && field) return field.slice(0, max);
  }
  return '';
}

function sleep(ms: number): Promise<null> {
  return new Promise(resolve => setTimeout(resolve, ms)).then(() => null);
}

/** Pages the pending text deltas sent so far for one (message, ordinal) part. */
function streamKey(data: Record<string, unknown>): string {
  const messageId = stringField(data, 'assistantMessageID');
  const ordinal = numberField(data, 'ordinal');
  return messageId ? `${messageId}#${ordinal}` : '';
}

/**
 * [v2-unverified] `session.text.delta` / `.ended` are keyed by
 * (assistantMessageID, ordinal) in the official reducer; that key is what makes
 * the lost-delta self-heal below unambiguous even when one run produces several
 * text parts.
 */
function applyDelta(
  writer: SseWriter,
  sessionId: string,
  data: Record<string, unknown>,
  state: OpenCodeRelayState
): void {
  const delta = stringField(data, 'delta');
  if (!delta) return;
  const clipped = delta.slice(0, MAX_DELTA_EVENT_CHARS);
  const key = streamKey(data);
  if (key) {
    state.textDeltas.set(
      key,
      (state.textDeltas.get(key) ?? 0) + clipped.length
    );
  }
  writer.emit('agent.text.delta', { session_id: sessionId, delta: clipped });
}

/**
 * [v2-unverified] `session.text.ended` carries the whole part. Replay the full
 * text only when the deltas actually sent do not already account for it: that
 * is the single self-heal channel for a delta the upstream never delivered, and
 * staying silent when the lengths agree keeps ``agent.text`` from overwriting
 * the stream the device is still appending to.
 */
function endText(
  writer: SseWriter,
  sessionId: string,
  data: Record<string, unknown>,
  state: OpenCodeRelayState
): void {
  const text = stringField(data, 'text');
  if (!text) return;
  const key = streamKey(data);
  const sent = key ? (state.textDeltas.get(key) ?? 0) : 0;
  if (key && sent >= text.length) return;
  writer.emit('agent.text', {
    session_id: sessionId,
    text: text.slice(0, MAX_TEXT_EVENT_CHARS),
  });
}

function applyReasoningDelta(
  writer: SseWriter,
  sessionId: string,
  data: Record<string, unknown>,
  state: OpenCodeRelayState
): void {
  const delta = stringField(data, 'delta');
  if (!delta) return;
  const clipped = delta.slice(0, MAX_REASONING_EVENT_CHARS);
  const key = streamKey(data);
  if (key) {
    state.reasoningDeltas.set(
      key,
      (state.reasoningDeltas.get(key) ?? 0) + clipped.length
    );
  }
  writer.emit('agent.reasoning.delta', {
    session_id: sessionId,
    delta: clipped,
  });
}

/**
 * Same lost-delta self-heal as `endText`, for the reasoning channel. Reasoning
 * is rendered as its own replace-in-place message and never enters the response
 * text, so a stray full frame here cannot corrupt the answer (P1).
 */
function endReasoning(
  writer: SseWriter,
  sessionId: string,
  data: Record<string, unknown>,
  state: OpenCodeRelayState
): void {
  const text = stringField(data, 'text');
  if (!text) return;
  const key = streamKey(data);
  const sent = key ? (state.reasoningDeltas.get(key) ?? 0) : 0;
  if (key && sent >= text.length) return;
  writer.emit('agent.reasoning', {
    session_id: sessionId,
    text: text.slice(0, MAX_REASONING_EVENT_CHARS),
  });
}

/**
 * [v2-unverified] `session.tool.success` reports the tool output in `content[]`;
 * prefer the first text entry so the device shows what the tool produced rather
 * than another copy of its input.
 */
/**
 * The name of the tool behind a call id, or a fixed placeholder when the
 * `input.started` frame that carried it was not seen. Upstream omits `name`
 * from `session.tool.called/.success/.failed` (verified against a real run
 * capture), so a relay that read it there labelled every block "tool" -- and
 * the device merges blocks by name, so every tool in a run collapsed into one.
 */
function toolName(
  state: OpenCodeRelayState,
  data: Record<string, unknown>
): string {
  const id = stringField(data, 'id');
  const known = id ? state.toolNames.get(id) : undefined;
  const name = known || stringField(data, 'name');
  return (name || 'tool').slice(0, 80);
}

function toolSuccessPreview(data: Record<string, unknown>): string {
  const content = Array.isArray(data.content) ? data.content : [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (stringField(record, 'type') === 'text') {
      const text = stringField(record, 'text');
      if (text) return text.slice(0, 160);
    }
  }
  return (
    previewValue(data.content) ||
    previewValue(data.metadata) ||
    previewValue(data.input) ||
    previewValue(data.state)
  );
}

function toolPreview(data: Record<string, unknown>): string {
  return (
    previewValue(data.input) ||
    previewValue(data.state) ||
    previewValue(data.metadata) ||
    previewValue(data.content) ||
    previewValue(data.patterns)
  );
}

function errorMessage(source: unknown, fallback: string): string {
  const record = asRecord(source);
  return (
    stringField(record, 'message') ||
    stringField(record, 'name') ||
    fallback
  ).slice(0, MAX_STATUS_MESSAGE_CHARS);
}

export function emitNormalizedOpenCodeEvent(
  writer: SseWriter,
  raw: unknown,
  sessionId: string,
  state: OpenCodeRelayState = createOpenCodeRelayState()
): 'continue' | 'activity' | 'complete' {
  const event = asRecord(raw) as OpenCodeEvent;
  const type = typeof event.type === 'string' ? event.type : '';
  const data = asRecord(event.data);
  // /event is server-wide: every attached session receives every run's events.
  // Fail closed when an event cannot be tied to the selected session — never
  // project another run onto this device.
  if (stringField(data, 'sessionID', 'sessionId') !== sessionId) {
    return 'continue';
  }

  switch (type) {
    // Terminators. v2 has no `session.status idle`; these are the only events
    // that end the device stream.
    case 'session.execution.succeeded': {
      writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
      return 'complete';
    }
    case 'session.execution.failed': {
      // Error first, then the terminator: without the trailing idle the device
      // waits out the 30-minute absolute cap and reports stream_incomplete
      // instead of the failure.
      writer.emit('agent.error', {
        session_id: sessionId,
        message: errorMessage(data.error, 'OpenCode 执行失败'),
      });
      writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
      return 'complete';
    }
    case 'session.execution.interrupted': {
      writer.emit('agent.error', {
        session_id: sessionId,
        message: '执行已中止',
      });
      writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
      return 'complete';
    }
    case 'global.disposed': {
      writer.emit('agent.error', {
        session_id: sessionId,
        message: 'OpenCode 服务已断开',
      });
      return 'activity';
    }

    // A failed step is not a failed run: the agent retries, so report the error
    // but keep the stream open. `fatal: false` is what tells the device to keep
    // running -- an unmarked `agent.error` ends the turn as a failure on the
    // device, so a step that retried successfully still ended up shown as one.
    case 'session.step.failed': {
      writer.emit('agent.error', {
        session_id: sessionId,
        message: errorMessage(data.error, 'Agent 执行步骤失败'),
        fatal: false,
      });
      return 'activity';
    }

    case 'session.step.started': {
      writer.emit('agent.status', {
        session_id: sessionId,
        status: 'busy',
        message: 'Agent 执行中',
      });
      return 'activity';
    }
    case 'session.compaction.started': {
      writer.emit('agent.status', {
        session_id: sessionId,
        status: 'busy',
        message: '正在压缩上下文',
      });
      return 'activity';
    }
    case 'session.retry.scheduled': {
      writer.emit('agent.status', {
        session_id: sessionId,
        status: 'retry',
        attempt: numberField(data, 'attempt') || undefined,
        message: errorMessage(data.error, 'Agent 即将重试'),
      });
      return 'activity';
    }

    case 'session.text.delta': {
      applyDelta(writer, sessionId, data, state);
      return 'activity';
    }
    case 'session.text.ended': {
      endText(writer, sessionId, data, state);
      return 'activity';
    }
    case 'session.reasoning.delta': {
      applyReasoningDelta(writer, sessionId, data, state);
      return 'activity';
    }
    case 'session.reasoning.ended': {
      endReasoning(writer, sessionId, data, state);
      return 'activity';
    }

    case 'session.tool.input.started': {
      // Not projected, but the only place the tool's *name* appears: the three
      // terminal tool events carry just the call id (verified against a real
      // run capture). Learn it here so those events can label the block.
      const id = stringField(data, 'id');
      const name = stringField(data, 'name');
      if (id && name) {
        state.toolNames.set(id, name.slice(0, 80));
      }
      return 'continue';
    }

    // The name of a tool call, falling back to a stable placeholder when the
    // `input.started` frame was never seen (a capture that starts mid-run).
    case 'session.tool.called': {
      const id = stringField(data, 'id');
      writer.emit('agent.tool', {
        session_id: sessionId,
        tool: toolName(state, data),
        call_id: id || undefined,
        status: 'running',
        preview: toolPreview(data),
      });
      return 'activity';
    }
    case 'session.tool.success': {
      writer.emit('agent.tool', {
        session_id: sessionId,
        tool: toolName(state, data),
        call_id: stringField(data, 'id') || undefined,
        status: 'done',
        preview: toolSuccessPreview(data),
      });
      return 'activity';
    }
    case 'session.tool.failed': {
      writer.emit('agent.tool', {
        session_id: sessionId,
        tool: toolName(state, data),
        call_id: stringField(data, 'id') || undefined,
        status: 'error',
        preview: errorMessage(data.error, '工具执行失败'),
      });
      return 'activity';
    }

    default:
      return 'continue';
  }
}

/**
 * Ask the upstream for pending asks and project the ones the device can still
 * answer. Nothing here may throw: a failed poll round only costs one interval,
 * and a thrown poll would tear down a healthy event stream.
 */
async function pollPendingAsks(input: {
  probe: OpenCodePendingProbe;
  writer: SseWriter;
  sessionId: string;
  state: OpenCodeRelayState;
}): Promise<void> {
  const { probe, writer, sessionId, state } = input;

  // Gate 1: nothing is running, so nothing can be waiting to be answered. This
  // is also what stops a stalely armed ask from being re-armed forever after
  // its run has already ended and been answered.
  let active: string[];
  try {
    active = await probe.activeSessions();
  } catch {
    return;
  }
  const watch = [sessionId];
  if (active.includes(sessionId)) {
    // Gate 2: subagents get their own session ids and can raise asks against
    // them, and a subagent may spawn mid-run — so re-read the child list every
    // round instead of caching it.
    try {
      for (const child of await probe.childSessions(sessionId)) {
        if (child && child !== sessionId && !watch.includes(child)) {
          watch.push(child);
        }
      }
    } catch {
      // A missing child list only narrows the watch list; keep going.
    }
  } else {
    return;
  }

  for (const target of watch) {
    let permissions: OpenCodePendingAsk[] = [];
    try {
      permissions = await probe.permissions(target);
    } catch {
      permissions = [];
    }
    // Both upstream queues are out-only: an ask leaves them the moment it is
    // answered, on the device or in OpenCode. That disappearance is the ONLY
    // signal the relay gets that the slot is free again -- nothing in the event
    // stream reports it. Without this check the first ask of a run occupies the
    // device's single slot forever, and every later ask in the same run is
    // silently dropped: the run blocks until it hits the stream timeout.
    if (
      state.pendingPermissionId &&
      !permissions.some(request => request?.id === state.pendingPermissionId)
    ) {
      state.pendingPermissionId = null;
    }

    // One live ask at a time, across both kinds: the device has a single option
    // bar, and a permission and a question cannot be pending together. Emitting
    // both would have the device drop the question -- and a dropped question is
    // a run that never finishes.
    if (!state.pendingPermissionId && !state.pendingQuestionId) {
      for (const request of permissions) {
        if (!request?.id || state.seenPermissions.has(request.id)) continue;
        state.seenPermissions.add(request.id);
        state.pendingPermissionId = request.id;
        emitAgentPermission(writer, target, request);
        break;
      }
    }
    // The option bar is taken for the rest of this round.
    if (state.pendingPermissionId || state.pendingQuestionId) return;

    let forms: OpenCodePendingQuestion[] = [];
    try {
      forms = await probe.questions(target);
    } catch {
      forms = [];
    }
    if (
      state.pendingQuestionId &&
      !forms.some(summary => summary?.id === state.pendingQuestionId)
    ) {
      state.pendingQuestionId = null;
    }
    if (state.pendingQuestionId) return;
    for (const summary of forms) {
      if (!summary?.id) continue;
      // Form.Info carries no state, so an id seen before is not enough to
      // know whether it was answered: re-attach must not re-arm a form the
      // user already answered in OpenCode. Pay for the detail read.
      let form = summary;
      if (!summary.status) {
        try {
          form = (await probe.formDetail(target, summary.id)) ?? summary;
        } catch {
          form = summary;
        }
      }
      if (form.status === 'answered' || form.status === 'cancelled') {
        state.seenQuestions.add(summary.id);
        continue;
      }
      if (state.seenQuestions.has(summary.id)) continue;
      state.seenQuestions.add(summary.id);
      state.pendingQuestionId = form.id;
      emitAgentQuestion(writer, target, form);
      return;
    }
  }
}

function emitAgentPermission(
  writer: SseWriter,
  sessionId: string,
  request: OpenCodePendingAsk
): void {
  writer.emit('agent.permission', {
    session_id: sessionId,
    permission_id: request.id,
    type: (request.action || 'tool').slice(0, 80),
    title: (request.title || 'OpenCode 请求权限').slice(0, 160),
    preview: request.preview,
  });
}

/**
 * Project a form onto the device's single-field question. The device answers
 * with an option value only — the cloud is what knows how to turn that into an
 * `answer` record, so no answer shape is ever assembled on device.
 */
function emitAgentQuestion(
  writer: SseWriter,
  sessionId: string,
  form: OpenCodePendingQuestion
): void {
  if (form.options.length === 0) {
    // Nothing the option bar can carry; the run would otherwise look stuck
    // behind a question that cannot be answered here.
    writer.emit('agent.status', {
      session_id: sessionId,
      status: 'busy',
      message: '检测到提问，请在 OpenCode 端回答',
    });
    return;
  }
  if (form.optionCount > MAX_QUESTION_OPTIONS) {
    writer.emit('agent.status', {
      session_id: sessionId,
      status: 'busy',
      message: `检测到 ${form.optionCount} 选项提问，请在 OpenCode 端回答`,
    });
    return;
  }
  writer.emit('agent.question', {
    session_id: sessionId,
    question_id: form.id,
    title: form.title || 'OpenCode 提问',
    options: form.options.slice(0, MAX_QUESTION_OPTIONS),
  });
}

/**
 * Observe mode: v2's event stream is live-only, so attaching to a finished run
 * delivers nothing at all. `outcome` is written when a run ends and is absent
 * on an idle session, so it is an exact "this run is over" signal — not a
 * timeout. Run mode never uses this: a running agent can legitimately be
 * silent for minutes.
 */
async function observeRunEnded(input: {
  probe: OpenCodePendingProbe;
  writer: SseWriter;
  sessionId: string;
  state: OpenCodeRelayState;
}): Promise<boolean> {
  const { probe, writer, sessionId, state } = input;
  let active: string[];
  try {
    active = await probe.activeSessions();
  } catch {
    return false;
  }
  if (active.includes(sessionId)) return false;
  let outcome = '';
  try {
    outcome = await probe.sessionOutcome(sessionId);
  } catch {
    return false;
  }
  if (!outcome) return false;
  state.pendingPermissionId = null;
  state.pendingQuestionId = null;
  writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
  return true;
}

export type OpenCodeRelayMode = 'run' | 'observe';

export async function relayOpenCodeEvents(input: {
  upstream: ReadableStream<Uint8Array>;
  writer: SseWriter;
  sessionId: string;
  mode?: OpenCodeRelayMode;
  probe?: OpenCodePendingProbe;
}): Promise<void> {
  const observe = input.mode === 'observe';
  const probe = input.probe;
  const pollIntervalMs = pendingPollIntervalMs();
  const reader = input.upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = createOpenCodeRelayState();
  // The read promise must survive poll iterations: re-issuing reader.read()
  // would queue a second consumption and lose the chunk the first one yields.
  let pendingRead = reader.read();
  let tick = 0;
  try {
    while (!input.writer.isClosed()) {
      // OpenCode can stay silent for a whole LLM/tool stretch. One timer drives
      // both the pending-ask poll and the heartbeat; a chunk always wins the
      // race, so a busy run never pays for the poll.
      const chunk = await Promise.race([pendingRead, sleep(pollIntervalMs)]);
      if (chunk === null) {
        tick += 1;
        if (tick % HEARTBEAT_EVERY_N_TICKS === 0) {
          input.writer.comment('keepalive');
        }
        if (probe) {
          await pollPendingAsks({
            probe,
            writer: input.writer,
            sessionId: input.sessionId,
            state,
          });
        }
        if (observe && probe) {
          const ended = await observeRunEnded({
            probe,
            writer: input.writer,
            sessionId: input.sessionId,
            state,
          });
          if (ended) return;
        }
        continue;
      }
      pendingRead = reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      // An unbounded buffer is a memory leak waiting for a frame that never
      // closes, so it still has to be capped -- but the cap used to abort the
      // whole run, and one oversized frame (a tool that dumped a huge file into
      // `content`) is not a run failure: the device loses that event and the
      // run keeps going. Discard through the end of the frame instead.
      while (buffer.length > MAX_UPSTREAM_FRAME_CHARS) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary < 0) {
          // Frame still opening: drop what we have and wait for its end. The
          // remainder is bounded by the next chunk, which the loop re-checks.
          buffer = '';
          break;
        }
        const separator =
          buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '';
        buffer = buffer.slice(boundary + separator.length);
      }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator =
          buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '';
        buffer = buffer.slice(boundary + separator.length);
        if (frame.length > MAX_UPSTREAM_FRAME_CHARS) {
          // Already projected past: nothing to emit, and nothing to end the
          // stream for either.
          boundary = buffer.search(/\r?\n\r?\n/);
          continue;
        }
        const data = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            const result = emitNormalizedOpenCodeEvent(
              input.writer,
              JSON.parse(data),
              input.sessionId,
              state
            );
            if (result === 'complete') return;
          } catch {
            // One malformed upstream event must not tear down an active run.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
