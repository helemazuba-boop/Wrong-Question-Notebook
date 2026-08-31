import type { SseWriter } from '@/lib/ai-stream';

const MAX_UPSTREAM_FRAME_CHARS = 64 * 1024;
const MAX_TEXT_EVENT_CHARS = 8 * 1024;
const MAX_DELTA_EVENT_CHARS = 2 * 1024;

interface OpenCodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
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

function eventSessionId(event: OpenCodeEvent): string {
  const properties = asRecord(event.properties);
  const part = asRecord(properties.part);
  const info = asRecord(properties.info);
  return (
    stringField(properties, 'sessionID', 'sessionId', 'session_id') ||
    stringField(part, 'sessionID', 'sessionId', 'session_id') ||
    stringField(info, 'sessionID', 'sessionId', 'session_id')
  );
}

export function emitNormalizedOpenCodeEvent(
  writer: SseWriter,
  raw: unknown,
  sessionId: string,
  allowIdle = true
): 'continue' | 'activity' | 'complete' {
  const event = asRecord(raw) as OpenCodeEvent;
  const type = typeof event.type === 'string' ? event.type : '';
  const properties = asRecord(event.properties);
  const eventSession = eventSessionId(event);
  // /event is server-wide. Fail closed when an upstream event cannot be tied
  // to the selected session; never project another run onto this device.
  if (eventSession !== sessionId) return 'continue';

  if (type === 'session.status') {
    const statusValue = properties.status;
    const status =
      typeof statusValue === 'string'
        ? statusValue
        : stringField(asRecord(statusValue), 'type');
    const statusObject = asRecord(statusValue);
    if (status === 'idle' && !allowIdle) return 'continue';
    writer.emit('agent.status', {
      session_id: sessionId,
      status: status || 'busy',
      attempt:
        typeof statusObject.attempt === 'number'
          ? statusObject.attempt
          : undefined,
      message: stringField(statusObject, 'message').slice(0, 240) || undefined,
    });
    return status === 'idle' ? 'complete' : 'activity';
  }

  if (type === 'session.idle') {
    if (!allowIdle) return 'continue';
    writer.emit('agent.status', { session_id: sessionId, status: 'idle' });
    return 'complete';
  }

  if (type === 'session.error') {
    const error = asRecord(properties.error);
    const data = asRecord(error.data);
    const message =
      stringField(data, 'message') ||
      stringField(error, 'message', 'name') ||
      'OpenCode session failed';
    writer.emit('agent.error', {
      session_id: sessionId,
      message: message.slice(0, 240),
    });
    return 'activity';
  }

  if (type === 'message.part.delta') {
    if (stringField(properties, 'field') === 'text') {
      const delta = stringField(properties, 'delta');
      if (delta) {
        writer.emit('agent.text.delta', {
          session_id: sessionId,
          delta: delta.slice(0, MAX_DELTA_EVENT_CHARS),
        });
      }
    }
    return 'activity';
  }

  if (type === 'message.part.updated') {
    const part = asRecord(properties.part);
    const partType = stringField(part, 'type');
    if (partType === 'text') {
      const text = stringField(part, 'text');
      if (text) {
        writer.emit('agent.text', {
          session_id: sessionId,
          text: text.slice(0, MAX_TEXT_EVENT_CHARS),
        });
      }
    } else if (partType === 'tool') {
      const state = asRecord(part.state);
      writer.emit('agent.tool', {
        session_id: sessionId,
        tool: (stringField(part, 'tool') || 'tool').slice(0, 80),
        status: (stringField(state, 'status') || 'running').slice(0, 40),
        preview:
          previewValue(state.input) ||
          previewValue(state.output) ||
          previewValue(state.error),
      });
    }
    return 'activity';
  }

  if (type === 'permission.asked' || type === 'permission.updated') {
    const metadata = asRecord(properties.metadata);
    const toolInput = asRecord(properties.tool_input);
    writer.emit('agent.permission', {
      session_id: sessionId,
      permission_id: stringField(properties, 'requestID', 'permissionID', 'id'),
      type: (
        stringField(properties, 'permission', 'type', 'tool_name') || 'tool'
      ).slice(0, 80),
      title: (
        stringField(properties, 'title', 'description') ||
        'OpenCode permission required'
      ).slice(0, 160),
      preview:
        previewValue(metadata) ||
        previewValue(toolInput) ||
        previewValue(properties.patterns),
    });
    return 'activity';
  }
  return 'continue';
}

export async function relayOpenCodeEvents(input: {
  upstream: ReadableStream<Uint8Array>;
  writer: SseWriter;
  sessionId: string;
}): Promise<void> {
  const reader = input.upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let activitySeen = false;
  try {
    while (!input.writer.isClosed()) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > MAX_UPSTREAM_FRAME_CHARS) {
        throw new Error('OpenCode SSE frame exceeded the relay limit');
      }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator =
          buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '';
        buffer = buffer.slice(boundary + separator.length);
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
              activitySeen
            );
            if (result === 'complete') return;
            if (result === 'activity') activitySeen = true;
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
