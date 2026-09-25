import 'server-only';

// Type-only: the gateway produces the values, the relay consumes them, and the
// edge stays type-checked in both directions without either module importing
// the other at runtime.
import type { OpenCodePendingProbe } from '@/lib/opencode-agent-events';

const DEFAULT_TIMEOUT_MS = 15_000;
// OpenCode's /event stream emits nothing during a long tool run (tests,
// installs), so the idle window must outlast the longest plausible silent
// stretch; the absolute cap below still bounds every attach.
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_EVENT_MAX_DURATION_MS = 30 * 60_000;
// One shared bound for every binding-scoped session list: device menu, run
// ownership re-checks, and create-session verification all must agree, or a
// session could be visible for selection but fail the action-time re-check.
export const OPENCODE_SESSION_LIST_LIMIT = 12;

// The device can only buffer one prompt response in internal RAM
// (`kMaxJsonResponseBytes` in opencode_client.cpp). A real session with two
// tool calls blows past that, so history is truncated here — cloud side, where
// the full upstream payload is available — instead of failing on the device.
export const OPENCODE_HISTORY_MESSAGE_LIMIT = 24;
// Budget for the serialized response body. Kept well under the device's 16 KiB
// hard ceiling so the HTTP envelope and JSON escaping stay inside it too.
export const OPENCODE_HISTORY_JSON_BUDGET_CHARS = 12 * 1024;
export const OPENCODE_HISTORY_TEXT_CHARS = 2 * 1024;
export const OPENCODE_HISTORY_THINKING_CHARS = 2 * 1024;
// Pinned by the frozen device contract: `historyTool.preview`, `agent.tool.preview`
// and `permission.preview` are all `maxLength: 160` in the schema. Nothing
// enforces that at runtime, so this constant is the only clamp.
export const OPENCODE_HISTORY_PREVIEW_CHARS = 160;
// The device option bar renders exactly two slots; a third collides with the
// key-hint strip. More options than this degrade to status text on device.
export const OPENCODE_QUESTION_OPTION_LIMIT = 2;

export interface OpenCodeSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export type OpenCodePermissionDecision = 'once' | 'reject';

export type OpenCodeHistoryToolStatus = 'running' | 'done' | 'error';

export interface OpenCodeHistoryTool {
  name: string;
  status: OpenCodeHistoryToolStatus;
  preview: string;
}

export interface OpenCodeHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  tools?: OpenCodeHistoryTool[];
}

export interface OpenCodePermissionRequest {
  id: string;
  sessionId: string;
  action: string;
  title: string;
  preview: string;
}

export interface OpenCodeQuestionOption {
  value: string;
  label: string;
}

/**
 * A form projected onto the single field the device can answer. `status` is
 * empty for `Form.Info` (upstream has no state on the list shape) and only
 * becomes pending/answered/cancelled through `loadOpenCodeFormDetail`.
 */
export interface OpenCodeFormState {
  id: string;
  sessionId: string;
  title: string;
  status: 'pending' | 'answered' | 'cancelled' | '';
  fieldKey: string;
  options: OpenCodeQuestionOption[];
  /** Raw option count before the two-slot device cap. */
  optionCount: number;
}

export type OpenCodeQuestionAnswerValue = string | number | boolean | string[];

export type OpenCodeQuestionAnswer = Record<
  string,
  OpenCodeQuestionAnswerValue
>;

export interface OpenCodeAgentBinding {
  baseUrl: string;
  directory: string;
  username: string;
  password: string;
  agent?: string;
  providerId?: string;
  modelId?: string;
}

export class OpenCodeGatewayError extends Error {
  constructor(
    public readonly code:
      | 'disabled'
      | 'forbidden'
      | 'invalid_response'
      | 'upstream_error'
      | 'upstream_timeout',
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'OpenCodeGatewayError';
  }
}

type RawBinding = Partial<{
  baseUrl: string;
  directory: string;
  username: string;
  password: string;
  agent: string;
  providerId: string;
  modelId: string;
}>;

function normalizeDirectory(value: string): string {
  const trimmed = value.trim();
  return trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '');
}

function normalizeBinding(raw: RawBinding): OpenCodeAgentBinding | null {
  const baseUrl = (raw.baseUrl || '').trim().replace(/\/+$/, '');
  const directory = normalizeDirectory(raw.directory || '');
  if (!/^https?:\/\//i.test(baseUrl) || !directory) return null;
  return {
    baseUrl,
    directory,
    username: (raw.username || 'opencode').trim() || 'opencode',
    password: raw.password || '',
    agent: raw.agent?.trim() || undefined,
    providerId: raw.providerId?.trim() || undefined,
    modelId: raw.modelId?.trim() || undefined,
  };
}

function bindingMap(): Record<string, RawBinding> {
  const raw = process.env.WQN_OPENCODE_USER_BINDINGS_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, RawBinding>)
      : {};
  } catch {
    throw new OpenCodeGatewayError(
      'disabled',
      'OpenCode user bindings are invalid',
      503
    );
  }
}

export function resolveOpenCodeBinding(userId: string): OpenCodeAgentBinding {
  const mapped = bindingMap()[userId];
  if (mapped) {
    const binding = normalizeBinding(mapped);
    if (binding) return binding;
    throw new OpenCodeGatewayError(
      'disabled',
      'OpenCode binding is incomplete',
      503
    );
  }

  const allowed = (process.env.WQN_OPENCODE_ALLOWED_USER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    throw new OpenCodeGatewayError(
      'disabled',
      'OpenCode Agent allowlist is not configured',
      503
    );
  }
  if (!allowed.includes(userId)) {
    throw new OpenCodeGatewayError(
      'forbidden',
      'OpenCode Agent is not enabled for this user',
      403
    );
  }

  const binding = normalizeBinding({
    baseUrl: process.env.WQN_OPENCODE_SERVER_URL,
    directory: process.env.WQN_OPENCODE_DIRECTORY,
    username: process.env.WQN_OPENCODE_SERVER_USERNAME,
    password: process.env.WQN_OPENCODE_SERVER_PASSWORD,
    agent: process.env.WQN_OPENCODE_AGENT,
    providerId: process.env.WQN_OPENCODE_PROVIDER_ID,
    modelId: process.env.WQN_OPENCODE_MODEL_ID,
  });
  if (!binding) {
    throw new OpenCodeGatewayError(
      'disabled',
      'OpenCode Agent gateway is not configured',
      503
    );
  }
  return binding;
}

function requestHeaders(binding: OpenCodeAgentBinding, json = false): Headers {
  const headers = new Headers({
    Accept: json ? 'application/json' : 'text/event-stream',
    'x-opencode-directory': encodeURIComponent(binding.directory),
  });
  if (json) headers.set('Content-Type', 'application/json');
  if (binding.password) {
    headers.set(
      'Authorization',
      `Basic ${Buffer.from(`${binding.username}:${binding.password}`).toString('base64')}`
    );
  }
  return headers;
}

function upstreamUrl(binding: OpenCodeAgentBinding, path: string): URL {
  const url = new URL(path, `${binding.baseUrl}/`);
  url.searchParams.set('directory', binding.directory);
  return url;
}

async function fetchUpstream(
  binding: OpenCodeAgentBinding,
  path: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(upstreamUrl(binding, path), {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OpenCodeGatewayError(
        'upstream_error',
        `OpenCode request failed with HTTP ${response.status}`,
        response.status >= 500 ? 502 : 424
      );
    }
    return response;
  } catch (error) {
    if (error instanceof OpenCodeGatewayError) throw error;
    if (controller.signal.aborted) {
      throw new OpenCodeGatewayError(
        'upstream_timeout',
        'OpenCode request timed out',
        504
      );
    }
    throw new OpenCodeGatewayError(
      'upstream_error',
      'OpenCode server is unavailable',
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v2 wraps every response in `{data}`. Read it and reject the error envelope
 * (`{_tag, message, kind}`) rather than letting `undefined` surface as a
 * valid-but-empty result.
 */
async function readDataEnvelope(
  binding: OpenCodeAgentBinding,
  path: string,
  label: string
): Promise<Record<string, unknown>> {
  const response = await fetchUpstream(binding, path, {
    method: 'GET',
    headers: requestHeaders(binding, true),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const data = body?.data;
  if (!data || typeof data !== 'object') {
    throw new OpenCodeGatewayError(
      'invalid_response',
      `OpenCode ${label} response is invalid`,
      502
    );
  }
  return data as Record<string, unknown>;
}

async function readDataRows(
  binding: OpenCodeAgentBinding,
  path: string,
  label: string
): Promise<Record<string, unknown>[]> {
  const response = await fetchUpstream(binding, path, {
    method: 'GET',
    headers: requestHeaders(binding, true),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  if (!Array.isArray(body?.data)) {
    throw new OpenCodeGatewayError(
      'invalid_response',
      `OpenCode ${label} response is invalid`,
      502
    );
  }
  return body.data.map(asRecord);
}

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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

function clampText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * First human-readable field of a tool payload. The key order matters: a bash
 * call carries `command`, an edit/patch carries `path`, a search carries
 * `pattern`, and a description always wins because it is the tool's own words.
 */
function previewValue(
  value: unknown,
  max = OPENCODE_HISTORY_PREVIEW_CHARS
): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of ['command', 'path', 'file', 'description', 'pattern']) {
    const field = object[key];
    if (typeof field === 'string' && field) return field.slice(0, max);
  }
  return '';
}

function sessionRow(row: unknown): OpenCodeSessionSummary | null {
  const record = asRecord(row);
  const id = stringField(record, 'id');
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) return null;
  const time = asRecord(record.time);
  // Session.Info.title is optional and is genuinely absent on fresh and failed
  // sessions; the device must render a placeholder rather than a blank row.
  return {
    id,
    title: clampText(stringField(record, 'title').trim() || '新 Session', 120),
    updatedAt: finiteTimestamp(time.updated),
  };
}

export async function listOpenCodeSessions(
  binding: OpenCodeAgentBinding,
  limit = OPENCODE_SESSION_LIST_LIMIT
): Promise<OpenCodeSessionSummary[]> {
  // `order=desc` (NOT `updated.desc`, which the server 400s), `parentID=null`
  // to exclude subagent sessions, and `?directory=` as the tenant boundary.
  // There is deliberately no client-side directory comparison: a session's own
  // `location.directory` is its worktree and is not forced to equal the
  // binding's startup directory — filtering on equality drops every row.
  const url = upstreamUrl(binding, '/api/session');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');
  url.searchParams.set('parentID', 'null');
  const sessions = await readDataRows(
    binding,
    url.pathname + url.search,
    'session list'
  );
  return sessions
    .map(sessionRow)
    .filter((session): session is OpenCodeSessionSummary => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(limit, OPENCODE_SESSION_LIST_LIMIT)));
}

/**
 * Create a fresh OpenCode session in the binding's directory. The created id
 * is verified with a targeted GET /api/session/:id because an id that cannot be
 * read back is not usable. (Re-listing the latest sessions cannot be used
 * here: a directory at the list cap can evict the fresh session and turn a
 * successful create into a false failure.)
 */
export async function createOpenCodeSession(
  binding: OpenCodeAgentBinding
): Promise<OpenCodeSessionSummary> {
  const body: Record<string, unknown> = {
    location: { directory: binding.directory },
  };
  // v2 moved the agent/model selection off the prompt request and onto session
  // creation: POST /api/session/:id/prompt only accepts `text` + `delivery`.
  if (binding.agent) body.agent = binding.agent;
  if (binding.providerId && binding.modelId) {
    body.model = { id: binding.modelId, providerID: binding.providerId };
  }
  const response = await fetchUpstream(binding, '/api/session', {
    method: 'POST',
    headers: requestHeaders(binding, true),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const created = (await response.json().catch(() => null)) as {
    data?: { id?: unknown };
  } | null;
  const id = typeof created?.data?.id === 'string' ? created.data.id : '';
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) {
    throw new OpenCodeGatewayError(
      'invalid_response',
      'OpenCode session creation returned an invalid id',
      502
    );
  }
  const row = await readDataEnvelope(
    binding,
    `/api/session/${encodeURIComponent(id)}`,
    'session detail'
  );
  if (stringField(row, 'id') !== id) {
    throw new OpenCodeGatewayError(
      'invalid_response',
      'Created OpenCode session is not readable after creation',
      502
    );
  }
  const time = asRecord(row.time);
  return {
    id,
    title: '新 Session',
    updatedAt: finiteTimestamp(time.updated) || Date.now(),
  };
}

export async function submitOpenCodePrompt(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  text: string
): Promise<void> {
  const response = await fetchUpstream(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: 'POST',
      headers: requestHeaders(binding, true),
      // `delivery: 'steer'` hands the text to a run already in flight instead
      // of queueing behind it; 'queue' is the alternative. The agent and model
      // were fixed at session-creation time and are not accepted here.
      body: JSON.stringify({ text, delivery: 'steer' }),
      cache: 'no-store',
    }
  );
  // 204 (or an empty body) is an accepted fire-and-forget submit.
  if (response.status === 204) return;
  const body = (await response.json().catch(() => null)) as {
    data?: Record<string, unknown>;
  } | null;
  if (!body?.data) return;
  if (
    stringField(body.data, 'sessionID') !== sessionId ||
    stringField(body.data, 'type') !== 'user'
  ) {
    throw new OpenCodeGatewayError(
      'invalid_response',
      'OpenCode prompt response is not an accepted user message',
      502
    );
  }
}

export async function replyOpenCodePermission(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  requestId: string,
  decision: OpenCodePermissionDecision
): Promise<void> {
  const body: Record<string, unknown> = { decision };
  // A bare reject surfaces as PermissionRejectedError and hard-blocks the
  // current run; a reject carrying a message is a corrective rejection that
  // lets the session continue with its next step.
  //
  // The v2 enum is once|always|reject, but only once|reject are reachable from
  // the device — the firmware permission reply carries a bool and writes
  // "once"/"reject" literally. A third value would be dead surface.
  if (decision === 'reject') {
    body.message = 'Rejected from WQN Note4';
  }
  await fetchUpstream(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
    {
      method: 'POST',
      headers: requestHeaders(binding, true),
      body: JSON.stringify(body),
      cache: 'no-store',
    }
  );
}

export class OpenCodeSessionAccessError extends Error {
  constructor(sessionId: string) {
    super(`OpenCode session ${sessionId} is not available for this binding`);
    this.name = 'OpenCodeSessionAccessError';
  }
}

/**
 * Session ids arrive from the device, so ownership is re-resolved at action
 * time against the binding-scoped authoritative list instead of trusting the
 * id or the OpenCode directory header/query alone. This deliberately lists only
 * root sessions, matching the device selector.
 *
 * A session that is not a root is still owned when its parent is: the relay
 * arms an ask against the subagent session that raised it, so the device
 * replies on that session's id, and answering it needs the gate to accept it.
 * The tenancy boundary is unchanged -- the parent must still be in the
 * binding-scoped list.
 *
 * That second case costs exactly one extra upstream read, not one per owned
 * session: the candidate's own record names its `parentID`, and the parent is
 * already in the list above, so the comparison is free. Enumerating children
 * instead walks every owned session (up to the 12 the device is shown) on every
 * route, and worst of all on the reject path, where it spends all of them to
 * reach the same refusal.
 */
export async function assertOpenCodeSessionAccess(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<void> {
  const ownedSessions = await listOpenCodeSessions(binding);
  if (ownedSessions.some(session => session.id === sessionId)) {
    return;
  }
  if (await isChildOfOwnedSession(binding, sessionId, ownedSessions)) {
    return;
  }
  throw new OpenCodeSessionAccessError(sessionId);
}

/**
 * True when `sessionId` is a subagent of a session in `owned`. Reads the
 * candidate directly and compares its `parentID` against the set the caller
 * already holds.
 *
 * A read that fails is a refusal, never a pass: an upstream that cannot answer
 * for the session is the same evidence as a session that does not exist, and
 * both mean this device has no claim on it. Distinguishing them would only
 * decide which error code to send, and the device surfaces `session_not_found`
 * for either.
 */
async function isChildOfOwnedSession(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  owned: OpenCodeSessionSummary[]
): Promise<boolean> {
  let row: Record<string, unknown>;
  try {
    row = await readDataEnvelope(
      binding,
      `/api/session/${encodeURIComponent(sessionId)}`,
      'session ownership'
    );
  } catch {
    return false;
  }
  const parentId = stringField(row, 'parentID');
  return parentId !== '' && owned.some(session => session.id === parentId);
}

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function openOpenCodeEventStream(
  binding: OpenCodeAgentBinding,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  // The absolute cap bounds a whole attach; the idle cap only fires when no
  // upstream byte has arrived for a while and is reset on every chunk, so a
  // legitimately long agent run is never cut off while it is still talking.
  const maxDurationTimer = setTimeout(
    () => controller.abort(),
    positiveEnvNumber(
      'WQN_OPENCODE_EVENT_MAX_DURATION_MS',
      DEFAULT_EVENT_MAX_DURATION_MS
    )
  );
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(),
      positiveEnvNumber(
        'WQN_OPENCODE_EVENT_IDLE_TIMEOUT_MS',
        DEFAULT_EVENT_IDLE_TIMEOUT_MS
      )
    );
    idleTimer.unref?.();
  };
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    resetIdleTimer();
    const response = await fetch(upstreamUrl(binding, '/api/event'), {
      method: 'GET',
      headers: requestHeaders(binding),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeGatewayError(
        'upstream_error',
        `OpenCode event stream failed with HTTP ${response.status}`,
        502
      );
    }
    // The caller owns the stream. Both timers are cleared when the upstream
    // body is closed by wrapping it rather than leaving detached timers.
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const result = await reader.read();
          if (result.done) {
            if (idleTimer) clearTimeout(idleTimer);
            clearTimeout(maxDurationTimer);
            streamController.close();
          } else {
            resetIdleTimer();
            streamController.enqueue(result.value);
          }
        } catch (error) {
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(maxDurationTimer);
          streamController.error(error);
        }
      },
      cancel() {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(maxDurationTimer);
        controller.abort();
        return reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxDurationTimer);
    if (error instanceof OpenCodeGatewayError) throw error;
    throw new OpenCodeGatewayError(
      controller.signal.aborted ? 'upstream_timeout' : 'upstream_error',
      controller.signal.aborted
        ? 'OpenCode event stream timed out'
        : 'OpenCode event stream is unavailable',
      controller.signal.aborted ? 504 : 502
    );
  }
}

/**
 * Read the full message history, oldest first. `order=desc` is what upstream
 * wants for a newest-first page, so rows are reversed locally rather than
 * trusting a second parameterization.
 */
export async function loadOpenCodeMessages(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  limit = OPENCODE_HISTORY_MESSAGE_LIMIT
): Promise<OpenCodeHistoryMessage[]> {
  const url = upstreamUrl(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/message`
  );
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');
  const rows = await readDataRows(
    binding,
    url.pathname + url.search,
    'message list'
  );

  const messages: OpenCodeHistoryMessage[] = [];
  for (const row of [...rows].reverse()) {
    const message = projectHistoryMessage(row);
    if (message) messages.push(message);
  }
  return trimHistoryToBudget(messages);
}

/**
 * `Session.Message.Info` is an 11-way anyOf. Only `user` and `assistant` carry
 * anything the device renders; `idle` is a turn boundary, and the remaining
 * eight kinds (agent/model/location switches, synthetic, system, skill, shell,
 * provider-state) are upstream bookkeeping with no device representation.
 */
function projectHistoryMessage(
  record: Record<string, unknown>
): OpenCodeHistoryMessage | null {
  const type = stringField(record, 'type');
  if (type === 'user') {
    // The user text is a top-level field on the message, not a content part.
    const text = stringField(record, 'text');
    return text
      ? { role: 'user', text: clampText(text, OPENCODE_HISTORY_TEXT_CHARS) }
      : null;
  }
  if (type !== 'assistant') return null;

  let text = '';
  let thinking = '';
  const tools: OpenCodeHistoryTool[] = [];
  // `retry` is a top-level `finish` state, not a content item; `content` is
  // exactly the Text | Reasoning | Tool union.
  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    const part = asRecord(item);
    const partType = stringField(part, 'type');
    if (partType === 'text') {
      text += stringField(part, 'text');
    } else if (partType === 'reasoning') {
      thinking += stringField(part, 'text');
    } else if (partType === 'tool') {
      const state = asRecord(part.state);
      // Do NOT use `executed` to decide whether a tool ran: it is false even
      // for completed calls in captured history. `state.status` is the only
      // reliable signal.
      const rawStatus = stringField(state, 'status');
      const status: OpenCodeHistoryToolStatus =
        rawStatus === 'completed'
          ? 'done'
          : rawStatus === 'error'
            ? 'error'
            : 'running';
      tools.push({
        name: (
          stringField(part, 'tool') ||
          stringField(part, 'name') ||
          'tool'
        ).slice(0, 80),
        status,
        // `firstTextContent` hands back a tool's raw text payload, so it needs
        // the same clamp as `previewValue`: unclamped, one `read` output
        // projected a single message to 56 KB, over the device's 16 KiB ceiling.
        preview:
          previewValue(state.input) ||
          clampText(
            firstTextContent(state.content),
            OPENCODE_HISTORY_PREVIEW_CHARS
          ) ||
          previewValue(state.error) ||
          previewValue(state.metadata),
      });
    }
  }
  const message: OpenCodeHistoryMessage = {
    role: 'assistant',
    text: clampText(text, OPENCODE_HISTORY_TEXT_CHARS),
  };
  if (thinking) {
    message.thinking = clampText(thinking, OPENCODE_HISTORY_THINKING_CHARS);
  }
  if (tools.length > 0) message.tools = tools.slice(0, 8);
  // A failed turn can be empty except for `error`; surface it so the device
  // does not render an empty bubble with no explanation.
  const error =
    stringField(asRecord(record.error), 'message') ||
    stringField(record, 'error');
  if (error && !text) {
    message.text = clampText(error, OPENCODE_HISTORY_TEXT_CHARS);
  }
  if (!message.text && !message.thinking && !message.tools) return null;
  return message;
}

function firstTextContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    const part = asRecord(item);
    if (stringField(part, 'type') === 'text') {
      const text = stringField(part, 'text');
      if (text) return text;
    }
  }
  return '';
}

/** Drop oldest messages until the response fits the device budget. */
function trimHistoryToBudget(
  messages: OpenCodeHistoryMessage[]
): OpenCodeHistoryMessage[] {
  const trimmed = [...messages];
  while (
    trimmed.length > 1 &&
    JSON.stringify(trimmed).length > OPENCODE_HISTORY_JSON_BUDGET_CHARS
  ) {
    trimmed.shift();
  }
  return trimmed;
}

/**
 * Pending asks. `Permission.Request` carries no state field — upstream enqueues
 * an ask on request and removes it on reply — so the list is the pending set.
 */
export async function listOpenCodePermissions(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<OpenCodePermissionRequest[]> {
  const rows = await readDataRows(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/permission`,
    'permission list'
  );
  const requests: OpenCodePermissionRequest[] = [];
  for (const record of rows) {
    const id = stringField(record, 'id');
    if (!id) continue;
    const action = stringField(record, 'action') || 'tool';
    const resources = Array.isArray(record.resources)
      ? record.resources.filter(
          (value): value is string => typeof value === 'string' && !!value
        )
      : [];
    requests.push({
      id,
      sessionId: stringField(record, 'sessionID') || sessionId,
      action: action.slice(0, 80),
      // Permission.Request.message is the human sentence upstream already
      // wrote; only compose one when it is absent.
      title: clampText(
        stringField(record, 'message') ||
          [action, ...resources].join(' ').trim() ||
          'OpenCode permission required',
        160
      ),
      preview: clampText(
        previewValue(asRecord(record.metadata)) || resources[0] || action,
        OPENCODE_HISTORY_PREVIEW_CHARS
      ),
    });
  }
  return requests;
}

/**
 * `GET /api/session/active` maps every running session id to its state; a
 * session absent from the map is inactive. Used as the cheap first gate before
 * any permission/form polling round.
 */
export async function listOpenCodeActiveSessions(
  binding: OpenCodeAgentBinding
): Promise<string[]> {
  const data = await readDataEnvelope(
    binding,
    '/api/session/active',
    'active sessions'
  );
  return Object.keys(data).filter(id => !!id);
}

/**
 * `GET /api/session/:id/form` returns `Form.Info`, which has NO state — a
 * reconnecting relay would re-arm an already-answered form. This list is only
 * good for discovery; `loadOpenCodeFormDetail` answers pending vs resolved.
 */
export async function listOpenCodeQuestions(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<OpenCodeFormState[]> {
  const rows = await readDataRows(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/form`,
    'form list'
  );
  const forms: OpenCodeFormState[] = [];
  for (const record of rows) {
    const form = projectForm(record, sessionId, '');
    if (form) forms.push(form);
  }
  return forms;
}

export async function loadOpenCodeFormDetail(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  formId: string
): Promise<OpenCodeFormState | null> {
  const data = await readDataEnvelope(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
    'form detail'
  );
  return projectForm(data, sessionId, formState(data));
}

function formState(data: Record<string, unknown>): OpenCodeFormState['status'] {
  const status = stringField(asRecord(data.state), 'status');
  if (status === 'pending' || status === 'answered' || status === 'cancelled') {
    return status;
  }
  // Form.State is a discriminated union on `status`; a missing status means the
  // union did not resolve, which for a Detail response is unexpected.
  return '';
}

/**
 * Project a form onto the one field the device can answer: skip hidden fields
 * and fields gated behind a `when[]` condition (the device has no other answers
 * to branch on), then take the first `string`/`multiselect` field that carries
 * options. Option labels fall back to the raw value when upstream omits them.
 */
function projectForm(
  form: Record<string, unknown>,
  sessionId: string,
  status: OpenCodeFormState['status']
): OpenCodeFormState | null {
  const id = stringField(form, 'id');
  if (!id) return null;
  const fields = Array.isArray(form.fields) ? form.fields : [];
  for (const rawField of fields) {
    const field = asRecord(rawField);
    if (field.hidden === true) continue;
    if (Array.isArray(field.when) && field.when.length > 0) continue;
    const fieldType = stringField(field, 'type');
    if (fieldType !== 'string' && fieldType !== 'multiselect') continue;
    const rawOptions = Array.isArray(field.options) ? field.options : [];
    if (rawOptions.length === 0) continue;
    const options: OpenCodeQuestionOption[] = [];
    for (const rawOption of rawOptions) {
      const option = asRecord(rawOption);
      const value =
        stringField(option, 'value') ||
        stringField(option, 'id') ||
        stringField(option, 'label');
      if (!value) continue;
      options.push({
        value,
        label: clampText(stringField(option, 'label') || value, 80),
      });
    }
    if (options.length === 0) continue;
    return {
      id,
      sessionId: stringField(form, 'sessionID') || sessionId,
      title: clampText(stringField(form, 'title') || 'OpenCode 提问', 160),
      status,
      fieldKey: stringField(field, 'key') || id,
      // Two slots is the device's hard geometry limit (a third collides with
      // the key-hint strip); more options degrade to status text on device.
      options: options.slice(0, OPENCODE_QUESTION_OPTION_LIMIT),
      optionCount: options.length,
    };
  }
  return null;
}

export async function replyOpenCodeQuestion(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  formId: string,
  answer: OpenCodeQuestionAnswer
): Promise<void> {
  await fetchUpstream(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
    {
      method: 'POST',
      headers: requestHeaders(binding, true),
      // Only the cloud knows a form's field ids, so the cloud assembles the
      // `answer` record; the device only ever sends a chosen option value.
      body: JSON.stringify({ answer }),
      cache: 'no-store',
    }
  );
}

/** Stop a submitted run. Returns whether upstream reports an interruption. */
export async function interruptOpenCodeSession(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<boolean> {
  const response = await fetchUpstream(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
    {
      method: 'POST',
      headers: requestHeaders(binding, true),
      cache: 'no-store',
    }
  );
  // Upstream answers a BARE `{interrupted:bool}` (SessionInterruptResponse) --
  // no `data` wrapper, unlike every other v2 route. Reading `.data.interrupted`
  // yields undefined for both values, so `!== false` reported every stop as
  // delivered. Tolerate both shapes rather than trusting the one we saw.
  const body = (await response.json().catch(() => null)) as {
    data?: { interrupted?: unknown };
    interrupted?: unknown;
  } | null;
  const reported = body?.data?.interrupted ?? body?.interrupted;
  return reported !== false;
}

/**
 * Spawned subagent sessions. A subagent can raise its own permission asks, so
 * the poller re-reads this every round rather than caching it.
 */
export async function listOpenCodeChildSessions(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  limit = 8
): Promise<OpenCodeSessionSummary[]> {
  const url = upstreamUrl(binding, '/api/session');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');
  url.searchParams.set('parentID', sessionId);
  const rows = await readDataRows(
    binding,
    url.pathname + url.search,
    'child session list'
  );
  return rows
    .map(sessionRow)
    .filter((session): session is OpenCodeSessionSummary => session !== null);
}

/**
 * `Session.Info.outcome` is only written when a run finishes (succeeded /
 * failed / interrupted) and is absent while a session is idle. That makes it
 * the exact marker for "this observed session is done", which the pure live
 * event stream cannot provide.
 */
export async function loadOpenCodeSessionOutcome(
  binding: OpenCodeAgentBinding,
  sessionId: string
): Promise<string> {
  const data = await readDataEnvelope(
    binding,
    `/api/session/${encodeURIComponent(sessionId)}`,
    'session detail'
  );
  return stringField(data, 'outcome');
}

/**
 * The six reads the event relay needs to discover pending asks and, in observe
 * mode, to tell a finished run from an idle one. v2 has no ask events: an ask
 * reaches the device only because the relay polls for it, so the relay needs a
 * binding-scoped view of these endpoints rather than the credentials itself.
 *
 * Every method rejects on upstream failure by design — the relay treats each
 * one as optional and keeps the event stream alive.
 */
export function createOpenCodePendingProbe(
  binding: OpenCodeAgentBinding
): OpenCodePendingProbe {
  return {
    activeSessions: () => listOpenCodeActiveSessions(binding),
    childSessions: async sessionId =>
      (await listOpenCodeChildSessions(binding, sessionId)).map(row => row.id),
    permissions: sessionId => listOpenCodePermissions(binding, sessionId),
    questions: sessionId => listOpenCodeQuestions(binding, sessionId),
    formDetail: (sessionId, formId) =>
      loadOpenCodeFormDetail(binding, sessionId, formId),
    sessionOutcome: sessionId => loadOpenCodeSessionOutcome(binding, sessionId),
  };
}
