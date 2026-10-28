import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSessionConfig } from '@/server/realtime-proxy/probe-session-config.mjs';

afterEach(() => vi.useRealTimers());

describe('bounded direct provider configuration probe', () => {
  it('records the actual type token through two updates, sends no inference/audio/tools and redacts secrets', async () => {
    const sockets: any[] = [];
    const sent: any[] = [];
    class FakeSocket extends EventEmitter {
      constructor() {
        super();
        sockets.push(this);
      }
      send(text: string) {
        const request = JSON.parse(text);
        sent.push(request);
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'session.updated',
              session: {
                ...request.session,
                turn_detection: { type: '', enabled: false },
                arbitrary_secret_field: 'fixture-key',
              },
            })
          ),
          false
        );
      }
      close() {
        this.emit('close', 1000);
      }
      terminate() {}
    }
    const pending = probeSessionConfig({
      apiKey: 'fixture-key',
      Socket: FakeSocket as any,
    });
    sockets[0].emit('open');
    sockets[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'session.created',
          session: { turn_detection: { type: 'fixture-key' } },
        })
      ),
      false
    );
    const result = await pending;
    expect(result.status).toBe('configuration-acks-observed');
    expect(sent.map(e => e.type)).toEqual(['session.update', 'session.update']);
    expect(
      sent.every(
        e => e.session.turn_detection === null && e.session.tools.length === 0
      )
    ).toBe(true);
    expect(result.events[1].turnDetection).toEqual({
      type: '',
      enabled: false,
    });
    expect(result.events[2].instructionsMatch).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    expect(JSON.stringify(result)).not.toContain(sent[0].session.instructions);
    expect(JSON.stringify(result)).not.toContain('arbitrary_secret_field');
  });

  it('times out an unresponsive provider without leaking raw socket errors', async () => {
    vi.useFakeTimers();
    class SilentSocket extends EventEmitter {
      close() {
        this.emit('close', 1000);
      }
      terminate() {}
    }
    const pending = probeSessionConfig({
      apiKey: 'fixture-key',
      Socket: SilentSocket as any,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toEqual(
      expect.objectContaining({ status: 'timeout', phase: 'connecting' })
    );
  });
});
