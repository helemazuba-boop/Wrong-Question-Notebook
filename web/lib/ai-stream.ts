// ai-stream.ts — SSE frame construction utilities for the v2 streaming path.
//
// The serialised frame format follows the WQN Cloud Relay §4.2 spec:
//
//     event: <event_name>
//     id: <monotonic_id>
//     data: <single-line json>
//     \n
//
// Frames are always terminated by a blank line (\n\n). The data payload is
// always a single JSON line — no embedded newlines — so the on-device SSE
// parser stays trivial.

import type { ReadableStreamDefaultController } from 'node:stream/web';

export interface SseFrame<T = unknown> {
  event: string;
  id?: number;
  data: T;
}

const encoder = new TextEncoder();

function serializeData(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

export function formatSseFrame<T>(frame: SseFrame<T>): string {
  const lines: string[] = [`event: ${frame.event}`];
  if (typeof frame.id === 'number') lines.push(`id: ${frame.id}`);
  lines.push(`data: ${serializeData(frame.data)}`);
  // Spec: each frame ends with a blank line.
  return `${lines.join('\n')}\n\n`;
}

/**
 * Counter that yields strictly monotonic 64-bit event ids. Used as the SSE
 * `id:` field so the device can resume via Last-Event-ID.
 */
export class SseEventIdGenerator {
  private nextId: number;

  constructor(base = 0) {
    const raw = Number(process.env.WQN_ESP32_AI_STREAM_EVENT_ID_BASE);
    this.nextId = Number.isSafeInteger(raw) && raw >= 0 ? raw : base;
  }

  /** Return the next id and advance the counter. */
  take(): number {
    return this.nextId++;
  }

  /** Peek at the next id without consuming it. Useful for tests. */
  peek(): number {
    return this.nextId;
  }
}

/**
 * Thin wrapper around a ReadableStreamDefaultController that knows how to
 * emit SSE frames in the order they were enqueued. The order matters because
 * the device correlates `id` to `event` and a re-order would corrupt the
 * monotonic-id contract.
 */
export class SseWriter {
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly idGenerator: SseEventIdGenerator
  ) {}

  emit<T>(event: string, data: T, opts: { explicitId?: number } = {}): number {
    if (this.closed) return -1;
    const id = opts.explicitId ?? this.idGenerator.take();
    const frame = formatSseFrame({ event, id, data });
    try {
      this.controller.enqueue(encoder.encode(frame));
    } catch {
      // controller may already be errored/closed if the device disconnected
      this.closed = true;
    }
    return id;
  }

  /** Emit a comment line (no event). Useful for keep-alives during long ops. */
  comment(text: string): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(encoder.encode(`: ${text}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // already closed
    }
  }

  error(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.error(new Error(reason));
    } catch {
      // already errored
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Build the standard SSE response envelope:
 *   HTTP 200 + Content-Type: text/event-stream + cache-control: no-store
 * The response body is a ReadableStream; the caller drives the SseWriter.
 */
export function createSseResponse(
  factory: (writer: SseWriter) => Promise<void>
): Response {
  let writerRef: SseWriter | null = null;
  const idGen = new SseEventIdGenerator();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writerRef = new SseWriter(controller, idGen);
    },
    async pull() {
      // No-op: we don't backpressure on read; enqueue calls throw if the
      // device has disconnected.
    },
    cancel() {
      writerRef?.close();
    },
  });

  // Drive the pipeline asynchronously. The ReadableStream contract guarantees
  // start() has run before pull(), so writerRef is non-null by the time
  // factory() runs.
  queueMicrotask(() => {
    if (!writerRef) return;
    factory(writerRef).finally(() => writerRef?.close());
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable nginx response buffering so SSE frames flush promptly.
      'X-Accel-Buffering': 'no',
    },
  });
}
