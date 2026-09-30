import type { SseWriter } from '@/lib/ai-stream';
import {
  OPENCODE_HISTORY_DETAIL_FULL,
  type OpenCodeHistoryDetail,
} from '@/lib/opencode-agent-detail';
import { clampCodePoints, clampUtf8Bytes } from '@/lib/utf8-clamp';

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
// The manifest bounds these in UTF-8 bytes (`text_event_bytes`,
// `delta_event_bytes`, `thinking_bytes`): the device copies them into fixed
// byte buffers, so a `.slice` on UTF-16 units would let a Chinese answer run
// ~3x over the buffer. `MAX_STATUS_MESSAGE_CHARS` is different -- the schema
// bounds `message` in code points, and 240 code points always fit the frame.
const MAX_TEXT_EVENT_BYTES = 8 * 1024;
const MAX_DELTA_EVENT_BYTES = 2 * 1024;
const MAX_REASONING_EVENT_BYTES = 2 * 1024;
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
 * An ask the relay has armed on the device, and the watched session it came
 * from. The session matters as much as the id: the device has one option bar,
 * so whichever ask holds it is the one the next reply answers, and an ask
 * raised by a subagent session belongs to that session rather than to the one
 * the device attached to. Replying on the attached session is a 404 against a
 * binding-scoped ownership check, which is why both halves travel together.
 */
export interface OpenCodePendingSlot {
  sessionId: string;
  id: string;
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
   * [detail] Assistant round whose text the device's live bubble is currently
   * showing. Brief tier only: one turn is several rounds and only the last one
   * is the answer, so a new round's first text frame clears the device buffer
   * (see applyDelta) instead of letting every round's lead-in pile up in front
   * of the answer. Empty until the first text frame of the attach.
   */
  textRoundKey: string;
  /**
   * The device holds one pending-ask string, period -- permission and question
   * share a single option bar. A live ask of either kind therefore blocks a new
   * ask of the other: the firmware drops what does not fit, and the poller
   * re-discovers it once the running one is answered.
   *
   * At most one of the two is ever set at a time -- the poll only fills a slot
   * when both are empty -- so "which slot is held" is also "what the option bar
   * is showing".
   */
  pendingPermission: OpenCodePendingSlot | null;
  pendingQuestion: OpenCodePendingSlot | null;
  /**
   * Device-requested detail tier. The live stream is the half of the tier the
   * history projection cannot cover: a run must not stream thinking the device
   * asked not to see, and the brief tier drops tool frames too, so the live
   * transcript matches what the same tier will later backfill.
   */
  detail: OpenCodeHistoryDetail;
}

export function createOpenCodeRelayState(
  detail: OpenCodeHistoryDetail = OPENCODE_HISTORY_DETAIL_FULL
): OpenCodeRelayState {
  return {
    seenPermissions: new Set<string>(),
    seenQuestions: new Set<string>(),
    textDeltas: new Map<string, number>(),
    reasoningDeltas: new Map<string, number>(),
    toolNames: new Map<string, string>(),
    textRoundKey: '',
    pendingPermission: null,
    pendingQuestion: null,
    detail,
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
  if (typeof value === 'string') return clampCodePoints(value, max);
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of ['command', 'path', 'file', 'description', 'pattern']) {
    const field = object[key];
    if (typeof field === 'string' && field) return clampCodePoints(field, max);
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
  const clipped = clampUtf8Bytes(delta, MAX_DELTA_EVENT_BYTES);
  const key = streamKey(data);
  const round = stringField(data, 'assistantMessageID');
  // [detail] Brief tier: rounds are model round-trips, and only the last one is
  // the answer. The device appends deltas into one buffer, so a new round's
  // first text frame clears it -- otherwise every round's lead-in ("让我看看：")
  // stays glued in front of the answer. An empty `agent.text` is the device's
  // existing "replace the buffer with this text" frame, and it never blanks an
  // already-mirrored block, so nothing flickers between rounds.
  if (
    state.detail < 1 &&
    round &&
    state.textRoundKey &&
    round !== state.textRoundKey
  ) {
    writer.emit('agent.text', { session_id: sessionId, text: '' });
  }
  if (round) state.textRoundKey = round;
  if (key) {
    state.textDeltas.set(
      key,
      (state.textDeltas.get(key) ?? 0) + clipped.length
    );
  }
  writer.emit('agent.text.delta', { session_id: sessionId, delta: clipped });
}

/** True when any text part of `round` already streamed deltas to the device. */
function roundHasDeltas(state: OpenCodeRelayState, round: string): boolean {
  for (const key of state.textDeltas.keys()) {
    if (key.startsWith(`${round}#`)) return true;
  }
  return false;
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
  const round = stringField(data, 'assistantMessageID');
  if (
    state.detail < 1 &&
    round &&
    state.textRoundKey &&
    round !== state.textRoundKey
  ) {
    // [detail] Brief tier: the bubble shows the newest round only. A round whose
    // deltas already went out has been superseded, so replaying its full text
    // would glue it back in front of the answer. A round whose deltas never
    // arrived is still the best thing to show: it becomes the current round.
    if (roundHasDeltas(state, round)) return;
    state.textRoundKey = round;
    writer.emit('agent.text', { session_id: sessionId, text: '' });
  }
  const sent = key ? (state.textDeltas.get(key) ?? 0) : 0;
  if (key && sent >= text.length) return;
  writer.emit('agent.text', {
    session_id: sessionId,
    text: clampUtf8Bytes(text, MAX_TEXT_EVENT_BYTES),
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
  const clipped = clampUtf8Bytes(delta, MAX_REASONING_EVENT_BYTES);
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
    text: clampUtf8Bytes(text, MAX_REASONING_EVENT_BYTES),
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
  return clampCodePoints(name || 'tool', 80);
}

function toolSuccessPreview(data: Record<string, unknown>): string {
  const content = Array.isArray(data.content) ? data.content : [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (stringField(record, 'type') === 'text') {
      const text = stringField(record, 'text');
      if (text) return clampCodePoints(text, 160);
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
  return clampCodePoints(
    stringField(record, 'message') || stringField(record, 'name') || fallback,
    MAX_STATUS_MESSAGE_CHARS
  );
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
  // `global.disposed` is server-wide by definition and carries no session id,
  // so it must be handled before the session filter below -- which is what used
  // to swallow it, leaving the device to wait out its 30-minute cap against a
  // server that no longer exists. Error first, then the idle terminator, then
  // close: the same shape as a failed run.
  if (type === 'global.disposed') {
    writer.emit('agent.error', {
      session_id: sessionId,
      message: 'OpenCode 服务已断开',
    });
    writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
    return 'complete';
  }
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
    // [detail] Below full, thinking is not the device's to see -- and both
    // halves must be skipped together: `endReasoning` self-heals a stream it
    // believes was truncated, so leaving it on would replay the whole reasoning
    // text as a single `agent.reasoning` frame.
    case 'session.reasoning.delta': {
      if (state.detail >= 2) {
        applyReasoningDelta(writer, sessionId, data, state);
      }
      return 'activity';
    }
    case 'session.reasoning.ended': {
      if (state.detail >= 2) {
        endReasoning(writer, sessionId, data, state);
      }
      return 'activity';
    }

    case 'session.tool.input.started': {
      // Not projected, but the only place the tool's *name* appears: the three
      // terminal tool events carry just the call id (verified against a real
      // run capture). Learn it here so those events can label the block.
      const id = stringField(data, 'id');
      const name = stringField(data, 'name');
      if (id && name) {
        state.toolNames.set(id, clampCodePoints(name, 80));
      }
      return 'continue';
    }

    // The name of a tool call, falling back to a stable placeholder when the
    // `input.started` frame was never seen (a capture that starts mid-run).
    // [detail] The brief tier suppresses the three terminal frames: they would
    // draw tool blocks that the next history load drops in favour of a digest.
    // `activity` is still returned -- the raw frame proves the run is alive,
    // and the device's own status label is the only feedback brief users get.
    case 'session.tool.called': {
      if (state.detail >= 1) {
        writer.emit('agent.tool', {
          session_id: sessionId,
          tool: toolName(state, data),
          call_id: stringField(data, 'id') || undefined,
          status: 'running',
          preview: toolPreview(data),
        });
      }
      return 'activity';
    }
    case 'session.tool.success': {
      if (state.detail >= 1) {
        writer.emit('agent.tool', {
          session_id: sessionId,
          tool: toolName(state, data),
          call_id: stringField(data, 'id') || undefined,
          status: 'done',
          preview: toolSuccessPreview(data),
        });
      }
      return 'activity';
    }
    case 'session.tool.failed': {
      if (state.detail >= 1) {
        writer.emit('agent.tool', {
          session_id: sessionId,
          tool: toolName(state, data),
          call_id: stringField(data, 'id') || undefined,
          status: 'error',
          preview: errorMessage(data.error, '工具执行失败'),
        });
      }
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
 *
 * The order of the two phases is the whole design, and both halves of it are
 * load-bearing:
 *
 *   1. Read every watched session's permission queue.
 *   2. Settle the permission slot against the queue it came from.
 *   3. Only if that leaves the bar free, read the form queues.
 *   4. Settle the question slot, then decide what to arm.
 *
 * A round that stops after step 2 because a permission is live cannot check a
 * question's liveness -- and so must not. The bar is taken; a question could
 * not be delivered while a permission is pending anyway. The trap this replaces
 * is the mirror image: stopping *before* step 4 made a live question skip its
 * own release check, so the first question of a run held the bar forever and
 * every later ask in that run was dropped.
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
  if (!active.includes(sessionId)) {
    return;
  }
  // Gate 2: subagents get their own session ids and can raise asks against
  // them, and a subagent may spawn mid-run — so re-read the child list every
  // round instead of caching it.
  const watch = [sessionId];
  try {
    for (const child of await probe.childSessions(sessionId)) {
      if (child && child !== sessionId && !watch.includes(child)) {
        watch.push(child);
      }
    }
  } catch {
    // A missing child list only narrows the watch list; keep going.
  }

  // Snapshot every watched session's permission queue before judging anything.
  // The pending ask is attributed to the session that raised it, so the only
  // correct liveness test reads that session's queue -- not whichever target the
  // loop happens to be on. Judging a subagent's live permission against the
  // parent's queue freed the bar while the ask was still pending, and the next
  // ask landed on top of a permission nobody had answered.
  //
  // A queue that failed to read is recorded as absent rather than empty: an
  // unreadable queue is not evidence that the ask left it, and treating it as
  // such would drop a live ask on a flaky round.
  const permissions = new Map<string, OpenCodePendingAsk[] | undefined>();
  for (const target of watch) {
    try {
      permissions.set(target, await probe.permissions(target));
    } catch {
      permissions.set(target, undefined);
    }
  }
  // Both upstream queues are out-only: an ask leaves them the moment it is
  // answered, on the device or in OpenCode. That disappearance is the ONLY
  // signal the relay gets that the slot is free again -- nothing in the event
  // stream reports it. Without this check the first ask of a run occupies the
  // device's single slot forever, and every later ask in the same run is
  // silently dropped: the run blocks until it hits the stream timeout.
  if (
    state.pendingPermission !== null &&
    permissions
      .get(state.pendingPermission.sessionId)
      ?.some(request => request?.id === state.pendingPermission?.id) === false
  ) {
    state.pendingPermission = null;
  }
  // The bar is taken for the rest of this round, and nothing could be delivered
  // while it is: a question cannot be shown on top of a permission, so the form
  // queues are not even worth reading.
  if (state.pendingPermission !== null) {
    return;
  }

  const forms = new Map<string, OpenCodePendingQuestion[] | undefined>();
  for (const target of watch) {
    try {
      forms.set(target, await probe.questions(target));
    } catch {
      forms.set(target, undefined);
    }
  }
  // The question's own release check, reached only once the permission slot is
  // known free. This has to run before the "arm a new ask" decision below: an
  // answered question that is never released here would block the bar for the
  // rest of the run.
  if (
    state.pendingQuestion !== null &&
    forms
      .get(state.pendingQuestion.sessionId)
      ?.some(summary => summary?.id === state.pendingQuestion?.id) === false
  ) {
    state.pendingQuestion = null;
  }
  if (state.pendingQuestion !== null) {
    return;
  }

  // Both slots are free, so at most one ask can be armed. Permission first: it
  // blocks the run, while a question only waits on the user.
  for (const target of watch) {
    for (const request of permissions.get(target) ?? []) {
      if (!request?.id || state.seenPermissions.has(request.id)) continue;
      state.seenPermissions.add(request.id);
      state.pendingPermission = { sessionId: target, id: request.id };
      emitAgentPermission(writer, target, request);
      return;
    }
  }
  for (const target of watch) {
    for (const summary of forms.get(target) ?? []) {
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
      state.pendingQuestion = { sessionId: target, id: form.id };
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
    type: clampCodePoints(request.action || 'tool', 80),
    title: clampCodePoints(request.title || 'OpenCode 请求权限', 160),
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
    title: clampCodePoints(form.title || 'OpenCode 提问', 160),
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
  // The attach is over, so nothing it armed can be answered any more. Both
  // slots go: one kind's ask left armed on a finished attach would hold the bar
  // against a run that is already done.
  state.pendingPermission = null;
  state.pendingQuestion = null;
  writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
  return true;
}

export type OpenCodeRelayMode = 'run' | 'observe';

/**
 * How a relay ended. The run route maps this onto the idempotency ledger; the
 * observe route ignores it. `client_closed` and `observe_ended` both mean no
 * terminator was seen -- the upstream run may still be executing.
 */
export type OpenCodeRelayOutcome =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'disposed'
  | 'upstream_ended'
  | 'observe_ended'
  | 'client_closed';

function terminalOutcomeFor(event: unknown): OpenCodeRelayOutcome {
  switch (asRecord(event).type) {
    case 'session.execution.succeeded':
      return 'succeeded';
    case 'session.execution.failed':
      return 'failed';
    case 'session.execution.interrupted':
      return 'interrupted';
    case 'global.disposed':
      return 'disposed';
    default:
      // Only those four events make emitNormalizedOpenCodeEvent return
      // 'complete', so this stays total without inventing a fifth terminator.
      return 'upstream_ended';
  }
}

export async function relayOpenCodeEvents(input: {
  upstream: ReadableStream<Uint8Array>;
  writer: SseWriter;
  sessionId: string;
  mode?: OpenCodeRelayMode;
  /** Device-requested tier; absent = full, so every old caller is unchanged. */
  detail?: OpenCodeHistoryDetail;
  probe?: OpenCodePendingProbe;
}): Promise<OpenCodeRelayOutcome> {
  const observe = input.mode === 'observe';
  const probe = input.probe;
  const pollIntervalMs = pendingPollIntervalMs();
  const reader = input.upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = createOpenCodeRelayState(input.detail);
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
          if (ended) return 'observe_ended';
        }
        continue;
      }
      pendingRead = reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      // An unbounded buffer is a memory leak waiting for a frame that never
      // closes, so it still has to be capped -- but the cap used to abort the
      // whole run, and one oversized frame (a tool that dumped a huge file into
      // `content`) is not a run failure: the device loses that event and the
      // run keeps going.
      //
      // So the cap only applies to a frame that is still opening. A buffer that
      // is over the cap but already holds complete frames is left to the drain
      // loop below, which drops the one frame that is too big and emits the
      // rest. Discarding from the front instead threw away the good frames in
      // front of it: a small frame that shared a chunk -- or was left over from
      // the previous round -- with a >64 KiB frame was dropped without ever
      // being parsed, which loses a real event while the run carries on.
      if (
        buffer.length > MAX_UPSTREAM_FRAME_CHARS &&
        buffer.search(/\r?\n\r?\n/) < 0
      ) {
        // No frame has closed yet and the buffer is already past the cap, so
        // the opening frame can never be one the relay accepts: drop what we
        // have and keep reading. The remainder is bounded by the next chunk,
        // which the loop re-checks.
        buffer = '';
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
            const event: unknown = JSON.parse(data);
            const result = emitNormalizedOpenCodeEvent(
              input.writer,
              event,
              input.sessionId,
              state
            );
            if (result === 'complete') return terminalOutcomeFor(event);
          } catch {
            // One malformed upstream event must not tear down an active run.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (chunk.done) return 'upstream_ended';
    }
    return 'client_closed';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
