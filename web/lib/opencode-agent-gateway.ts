import 'server-only';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EVENT_TIMEOUT_MS = 5 * 60_000;

export interface OpenCodeSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

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

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function listOpenCodeSessions(
  binding: OpenCodeAgentBinding,
  limit = 8
): Promise<OpenCodeSessionSummary[]> {
  const response = await fetchUpstream(binding, '/session', {
    method: 'GET',
    headers: requestHeaders(binding, true),
    cache: 'no-store',
  });
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new OpenCodeGatewayError(
      'invalid_response',
      'OpenCode session response is invalid',
      502
    );
  }

  return body
    .map(value => {
      const row = value as Record<string, unknown>;
      const time =
        row.time && typeof row.time === 'object'
          ? (row.time as Record<string, unknown>)
          : {};
      return {
        id: typeof row.id === 'string' ? row.id : '',
        title:
          typeof row.title === 'string' && row.title.trim()
            ? row.title.trim().slice(0, 120)
            : 'Untitled session',
        bindingDirectory:
          typeof row.directory === 'string'
            ? normalizeDirectory(row.directory)
            : '',
        updatedAt:
          finiteTimestamp(time.updated) || finiteTimestamp(row.updated_at),
      };
    })
    .filter(
      session =>
        /^ses_[A-Za-z0-9_-]+$/.test(session.id) &&
        session.bindingDirectory === binding.directory
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(limit, 12)))
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

export async function submitOpenCodePrompt(
  binding: OpenCodeAgentBinding,
  sessionId: string,
  text: string
): Promise<void> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
  };
  if (binding.agent) body.agent = binding.agent;
  if (binding.providerId && binding.modelId) {
    body.model = {
      providerID: binding.providerId,
      modelID: binding.modelId,
    };
  }
  await fetchUpstream(
    binding,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    {
      method: 'POST',
      headers: requestHeaders(binding, true),
      body: JSON.stringify(body),
      cache: 'no-store',
    }
  );
}

export async function openOpenCodeEventStream(
  binding: OpenCodeAgentBinding,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_EVENT_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(upstreamUrl(binding, '/event'), {
      method: 'GET',
      headers: requestHeaders(binding),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      throw new OpenCodeGatewayError(
        'upstream_error',
        `OpenCode event stream failed with HTTP ${response.status}`,
        502
      );
    }
    // The caller owns the stream. Cancel the timer when the upstream body is
    // closed by wrapping it rather than leaving a detached five-minute timer.
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const result = await reader.read();
          if (result.done) {
            clearTimeout(timer);
            streamController.close();
          } else {
            streamController.enqueue(result.value);
          }
        } catch (error) {
          clearTimeout(timer);
          streamController.error(error);
        }
      },
      cancel() {
        clearTimeout(timer);
        controller.abort();
        return reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    clearTimeout(timer);
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
