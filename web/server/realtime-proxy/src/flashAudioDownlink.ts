import { encodeWflvAudio } from './frameIo.ts';
import { DOWLINK_DEFAULT_SAMPLE_RATE_HZ } from './types.ts';

interface AudioSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
}

interface ResponseAudio {
  pending: number;
  samples: number;
  ended: boolean;
  notified: boolean;
}

interface AudioPacket {
  responseId: string;
  pcm: Buffer;
}

/** Per-connection, bounded PCM pacing. Generation completion is not playout. */
export class FlashAudioDownlink {
  static readonly PACKET_BYTES = 960; // 20 ms of complete 24 kHz PCM16 samples.
  static readonly MAX_QUEUED_BYTES = 2 * 1024 * 1024;
  static readonly MAX_SOCKET_BYTES = 256 * 1024;
  private static readonly LOOK_AHEAD_MS = 300;
  private static readonly START_WAIT_MS = 120;
  private static readonly STALL_MS = 10_000;
  private readonly responses = new Map<string, ResponseAudio>();
  private queue: AudioPacket[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tokens = 0;
  private lastRefill: number | null = null;
  private pressureSince: number | null = null;
  private sequence = 0;
  private epoch = 1;
  private epochEnabled = false;
  private closed = false;

  constructor(
    private readonly socket: AudioSocket,
    private readonly fail: (reason: string) => void
  ) {}

  negotiateEpoch(enabled: boolean) {
    this.epochEnabled = enabled;
    if (enabled) this.notifyReset();
  }

  begin(responseId: string) {
    if (this.closed || !responseId || responseId.length > 256) return;
    if (this.responses.has(responseId)) return;
    // Only the relay's response.created path opens IDs. Audio data itself
    // never registers an unknown response; the relay also filters retired IDs.
    if (this.responses.size >= 128) {
      this.abort('too-many-responses');
      return;
    }
    this.responses.set(responseId, {
      pending: 0,
      samples: 0,
      ended: false,
      notified: false,
    });
    this.control('playback.response', { response_id: responseId });
  }

  accepts(responseId: unknown): responseId is string {
    return (
      !this.closed &&
      typeof responseId === 'string' &&
      this.responses.has(responseId)
    );
  }

  append(responseId: unknown, base64: unknown) {
    if (!this.accepts(responseId) || typeof base64 !== 'string') return;
    const response = this.responses.get(responseId)!;
    if (response.ended) return;
    // Check size before decoding/allocating; account every queued PCM byte.
    const remaining = FlashAudioDownlink.MAX_QUEUED_BYTES - this.queuedBytes;
    if (base64.length > Math.ceil(remaining / 3) * 4 + 4) {
      this.abort('audio-queue-limit');
      return;
    }
    const padding = base64.indexOf('=');
    if (
      base64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(base64) ||
      (padding !== -1 &&
        (padding < base64.length - 2 ||
          !/^={1,2}$/.test(base64.slice(padding))))
    ) {
      this.abort('invalid-audio-encoding');
      return;
    }
    const pcm = Buffer.from(base64, 'base64');
    if (pcm.length % 2 !== 0 || pcm.length > remaining) {
      this.abort('invalid-or-oversized-audio');
      return;
    }
    for (
      let offset = 0;
      offset < pcm.length;
      offset += FlashAudioDownlink.PACKET_BYTES
    ) {
      // Copy each bounded packet, so one small remainder cannot pin a huge delta.
      const part = Buffer.from(
        pcm.subarray(offset, offset + FlashAudioDownlink.PACKET_BYTES)
      );
      this.queue.push({ responseId, pcm: part });
      this.queuedBytes += part.length;
      response.pending++;
      response.samples += part.length / 2;
    }
    if (this.queue.length && this.timer === null) {
      // Start after a small bounded prebuffer, including when audio.done never
      // arrives. The pacer never needs to afford an entire provider delta.
      this.schedule(FlashAudioDownlink.START_WAIT_MS);
    }
  }

  finish(responseId: unknown) {
    if (!this.accepts(responseId)) return;
    const response = this.responses.get(responseId)!;
    response.ended = true;
    if (response.pending === 0) this.notifyEnd(responseId, response);
    else if (this.timer === null) this.schedule(0);
  }

  cancel() {
    this.clearQueue();
    this.responses.clear();
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    this.notifyReset();
  }

  close() {
    this.closed = true;
    this.clearQueue();
    this.responses.clear();
  }

  private clearQueue() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.tokens = 0;
    this.lastRefill = null;
    this.pressureSince = null;
  }

  private abort(reason: string) {
    this.close();
    this.fail(reason);
  }

  private control(type: string, fields: Record<string, unknown> = {}) {
    if (!this.epochEnabled || this.closed) return;
    try {
      this.socket.send(JSON.stringify({ type, epoch: this.epoch, ...fields }));
    } catch {
      this.abort('device-send-failed');
    }
  }

  private notifyReset() {
    this.control('playback.reset');
  }

  private notifyEnd(id: string, response: ResponseAudio) {
    if (response.notified) return;
    response.notified = true;
    // This is relay-send completion. The device must still drain its own PCM
    // and DMA before reporting actual playback completion to the UI.
    this.control('playback.end', {
      response_id: id,
      samples: response.samples,
    });
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delay);
  }

  private drain() {
    if (this.closed || this.queue.length === 0) return;
    if (this.socket.readyState !== 1) {
      this.abort('device-not-open');
      return;
    }
    const now = Date.now();
    this.tokens =
      this.lastRefill === null
        ? FlashAudioDownlink.LOOK_AHEAD_MS
        : Math.min(
            FlashAudioDownlink.LOOK_AHEAD_MS,
            this.tokens + Math.max(0, now - this.lastRefill)
          );
    this.lastRefill = now;
    while (this.queue.length) {
      const packet = this.queue[0];
      const duration =
        (packet.pcm.length / (DOWLINK_DEFAULT_SAMPLE_RATE_HZ * 2)) * 1000;
      if (this.tokens + 1e-6 < duration) break;
      if (
        (this.socket.bufferedAmount ?? 0) + packet.pcm.length + 24 >
        FlashAudioDownlink.MAX_SOCKET_BYTES
      ) {
        this.pressureSince ??= now;
        if (now - this.pressureSince >= FlashAudioDownlink.STALL_MS) {
          this.abort('device-backpressure-timeout');
          return;
        }
        this.schedule(20);
        return;
      }
      this.pressureSince = null;
      try {
        this.socket.send(
          encodeWflvAudio({
            pcm: packet.pcm,
            seq: ++this.sequence >>> 0,
            epoch: this.epochEnabled ? this.epoch : 0,
          }),
          { binary: true }
        );
      } catch {
        this.abort('device-send-failed');
        return;
      }
      this.queue.shift();
      this.queuedBytes -= packet.pcm.length;
      this.tokens -= duration;
      const response = this.responses.get(packet.responseId);
      if (response) {
        response.pending--;
        if (response.ended && response.pending === 0)
          this.notifyEnd(packet.responseId, response);
      }
      if (this.closed) return;
    }
    if (this.queue.length) this.schedule(20);
  }
}
