import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlashAudioDownlink } from '@/server/realtime-proxy/src/flashAudioDownlink';

const instances: FlashAudioDownlink[] = [];

function setup() {
  const sent: Array<string | Buffer> = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer) {
      sent.push(data);
    },
  };
  const fail = vi.fn();
  const audio = new FlashAudioDownlink(socket, fail);
  instances.push(audio);
  return {
    audio,
    socket,
    fail,
    sent,
    frames: () =>
      sent.filter((value): value is Buffer => Buffer.isBuffer(value)),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
  vi.useRealTimers();
});

describe('Flash bounded streaming audio', () => {
  it('delivers first PCM without waiting for provider audio.done', () => {
    const h = setup();
    h.audio.begin('response-1');
    h.audio.append('response-1', Buffer.alloc(48000, 7).toString('base64'));
    expect(h.frames()).toHaveLength(0);
    vi.advanceTimersByTime(120);
    expect(h.frames().length).toBeGreaterThan(0);
    // A provider burst cannot put the entire second onto the socket at once.
    expect(
      Buffer.concat(h.frames().map(frame => frame.subarray(24))).length
    ).toBeLessThan(48000);
    vi.advanceTimersByTime(1200);
    expect(Buffer.concat(h.frames().map(frame => frame.subarray(24)))).toEqual(
      Buffer.alloc(48000, 7)
    );
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('rechunks a legal large delta instead of blocking behind the token cap', () => {
    const h = setup();
    const pcm = Buffer.alloc(72002, 31);
    h.audio.begin('large');
    h.audio.append('large', pcm.toString('base64'));
    h.audio.finish('large');
    vi.advanceTimersByTime(2000);
    expect(Buffer.concat(h.frames().map(frame => frame.subarray(24)))).toEqual(
      pcm
    );
    expect(h.frames().every(frame => frame.length <= 984)).toBe(true);
    expect(h.frames().map(frame => frame.readUInt32LE(8))).toEqual(
      h.frames().map((_, index) => index + 1)
    );
  });

  it('discards already-queued and newly-arriving retired response audio', () => {
    const h = setup();
    h.audio.begin('old');
    h.audio.append('old', Buffer.alloc(960, 1).toString('base64'));
    h.audio.cancel();
    h.audio.append('old', Buffer.alloc(960, 2).toString('base64'));
    h.audio.finish('old');
    vi.advanceTimersByTime(1000);
    expect(h.frames()).toHaveLength(0);
    h.audio.begin('new');
    h.audio.append('new', Buffer.alloc(960, 3).toString('base64'));
    vi.advanceTimersByTime(120);
    expect(h.frames()).toHaveLength(1);
    expect(h.frames()[0].subarray(24)).toEqual(Buffer.alloc(960, 3));
  });

  it('bounds socket pressure and fails explicitly when the peer stays blocked', () => {
    const h = setup();
    h.socket.bufferedAmount = 32 * 1024 * 1024;
    h.audio.begin('blocked');
    h.audio.append('blocked', Buffer.alloc(48000).toString('base64'));
    vi.advanceTimersByTime(11000);
    expect(h.frames()).toHaveLength(0);
    expect(h.fail).toHaveBeenCalledExactlyOnceWith(
      'device-backpressure-timeout'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds aggregate PCM even if the provider keeps sending', () => {
    const h = setup();
    h.audio.begin('overflow');
    for (let i = 0; i < 50; i++) {
      h.audio.append('overflow', Buffer.alloc(48000).toString('base64'));
    }
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.frames()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['!!!=', 'AA==', 'AB=C', 'A==='])(
    'rejects malformed or odd PCM %s',
    payload => {
      const h = setup();
      h.audio.begin('invalid');
      h.audio.append('invalid', payload);
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.frames()).toHaveLength(0);
    }
  );

  it('uses the reserved epoch only after explicit capability negotiation', () => {
    const h = setup();
    h.audio.begin('legacy');
    h.audio.append('legacy', Buffer.alloc(960).toString('base64'));
    vi.advanceTimersByTime(120);
    expect(h.frames()[0].readUInt32LE(20)).toBe(0);
    h.audio.negotiateEpoch(true);
    h.audio.cancel();
    h.audio.begin('capable');
    h.audio.append('capable', Buffer.alloc(960).toString('base64'));
    h.audio.finish('capable');
    expect(
      h.sent
        .filter(value => typeof value === 'string')
        .some(value => JSON.parse(value as string).type === 'playback.end')
    ).toBe(false);
    vi.advanceTimersByTime(120);
    const frame = h.frames().at(-1)!;
    expect(frame.readUInt32LE(20)).toBeGreaterThan(0);
    const end = h.sent
      .filter((value): value is string => typeof value === 'string')
      .map(value => JSON.parse(value))
      .find(value => value.type === 'playback.end');
    expect(end).toMatchObject({
      response_id: 'capable',
      epoch: frame.readUInt32LE(20),
      samples: 480,
    });
    // Relay queue completion is deliberately not a claim of device playout.
    expect(end).not.toHaveProperty('status');
  });
});
