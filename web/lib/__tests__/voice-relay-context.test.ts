import { EventEmitter } from 'events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RelaySession } from '@/server/realtime-proxy/src/voiceRelay';
import { encodeWflvAudio } from '@/server/realtime-proxy/src/frameIo';
const { context, execute } = vi.hoisted(() => ({
  context: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('@/server/realtime-proxy/src/toolInterceptor', async () => ({
  ...(await vi.importActual('@/server/realtime-proxy/src/toolInterceptor')),
  fetchVoiceContext: context,
  executeToolOverHttp: execute,
}));
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send(message: string | Buffer) {
    this.sent.push(message);
  }
  close() {
    this.readyState = 3;
  }
  ping() {}
  events() {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map(s => JSON.parse(s));
  }
}
const first = {
  now: '2026-10-14T12:00:00Z',
  timezone: 'Asia/Shanghai',
  notebooks: [{ id: 'notebook-1', title: '数学', subject_name: '数学' }],
  notebooks_available: true,
  notebooks_truncated: false,
};
const sessions: RelaySession[] = [];
const receipt = {
  ok: true,
  display: 'Note saved',
  data: { note: { id: 'saved-note' } },
  action: null,
};
function setup() {
  const device = new Socket(),
    upstream = new Socket();
  context.mockResolvedValue(first);
  execute.mockResolvedValue(receipt);
  const session = new RelaySession(
    device as any,
    upstream as any,
    { userId: 'user-1', deviceId: 'device-1', macAddress: 'mac' },
    {
      bind: '',
      port: 0,
      upstream: { url: '', apiKey: '', model: '' },
      executeToolUrl: 'https://wqn.test/api/esp32/ai/execute-tool',
      proxySecret: 'secret',
      transcribeChatUrl: '',
      agentTranscribeUrl: '',
      realtimeEnabled: true,
    }
  );
  sessions.push(session);
  const frame = (event: unknown) =>
    session.onDeviceFrame(Buffer.from(JSON.stringify(event)), false);
  const provider = (event: unknown) =>
    session.onUpstreamFrame(Buffer.from(JSON.stringify(event)), false);
  const ack = () => {
    const update = upstream
      .events()
      .filter(e => e.type === 'session.update')
      .at(-1);
    expect(update).toBeDefined();
    provider({ type: 'session.updated', session: update.session });
  };
  const configure = async () => {
    frame({
      type: 'session.update',
      wqn: { playback_epoch: 1 },
      session: { instructions: 'base', tools: [] },
    });
    await settle();
    ack();
    await settle();
  };
  const start = async (id: string) => {
    frame({ type: 'response.create' });
    await settle();
    ack();
    await settle();
    provider({ type: 'response.created', response: { id } });
  };
  return { device, upstream, session, frame, provider, ack, configure, start };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function tool(call_id: string, response_id?: string) {
  return {
    type: 'response.function_call_arguments.done',
    call_id,
    response_id,
    name: 'create_notebook_note',
    arguments: '{"title":"复习"}',
  };
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.shutdown('test-end');
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('Flash configuration, response and tool ownership', () => {
  it('requires a provider ACK of the explicit manual PCM profile before ready', async () => {
    const h = setup();
    h.frame({
      type: 'session.update',
      wqn: { playback_epoch: 1 },
      session: { instructions: 'base' },
    });
    await settle();
    const update = h.upstream.events()[0];
    expect(update.wqn).toBeUndefined();
    expect(update.session.tools).toHaveLength(8);
    expect(update.session.instructions).toContain('notebook-1');
    expect(update.session.turn_detection).toBeNull();
    h.provider({ type: 'session.created', session: {} });
    h.provider({
      type: 'session.updated',
      session: { turn_detection: { type: 'server_vad' } },
    });
    await settle();
    expect(h.device.events().some(e => e.type === 'session.ready')).toBe(false);
    h.ack();
    await settle();
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'session.ready',
        wqn: { playback_epoch: 1, turn_detection: 'manual' },
      })
    );
  });
  it('closes both sockets on an unconfirmed configuration', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.frame({ type: 'session.update', session: {} });
    await settle();
    await vi.advanceTimersByTimeAsync(10001);
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
  });
  it('refreshes calendar context and waits for its configuration ACK before create', async () => {
    const h = setup();
    await h.configure();
    context.mockResolvedValue({ ...first, now: '2026-10-15T16:00:00Z' });
    h.frame({ type: 'response.create' });
    expect(h.device.events().at(-1)).toEqual(
      expect.objectContaining({ type: 'playback.reset' })
    );
    expect(h.device.events()).toContainEqual({
      type: 'turn.started',
      turn_id: 1,
    });
    await settle();
    expect(h.upstream.events().at(-1).session.instructions).toContain(
      '2026-10-16'
    );
    expect(h.upstream.events().some(e => e.type === 'response.create')).toBe(
      false
    );
    h.ack();
    await settle();
    expect(h.upstream.events().at(-1)).toEqual({ type: 'response.create' });
  });
  it('cannot cancel a pending context denial to retain an authorized connection', async () => {
    const h = setup();
    await h.configure();
    let reject!: (error: Error) => void;
    context.mockReturnValue(
      new Promise((_resolve, r) => {
        reject = r;
      })
    );
    h.frame({ type: 'response.create' });
    await settle();
    h.frame({ type: 'response.cancel' });
    reject(new Error('account disabled'));
    await settle();
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
    expect(h.upstream.events().some(e => e.type === 'response.create')).toBe(
      false
    );
  });
  it('closes on context failure even when device error delivery throws', async () => {
    const h = setup();
    context.mockRejectedValue(new Error('context denied'));
    h.device.send = () => {
      throw new Error('gone');
    };
    h.frame({ type: 'session.update', session: {} });
    await settle();
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
    expect(h.upstream.events()).toEqual([]);
  });
  it('fences cancel/create and rejects late old tool calls before and after the next response', async () => {
    const h = setup();
    await h.configure();
    await h.start('old');
    h.frame({ type: 'response.cancel' });
    h.provider(tool('old-late-1', 'old'));
    h.provider(tool('unbound-old'));
    h.frame({ type: 'response.create' });
    await settle();
    h.ack();
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    h.provider({
      type: 'response.done',
      response: { id: 'old', status: 'cancelled' },
    });
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(2);
    h.provider({ type: 'response.created', response: { id: 'new' } });
    h.provider(tool('old-late-2', 'old'));
    h.provider(tool('unbound-old-2'));
    await settle();
    expect(execute).not.toHaveBeenCalled();
    h.provider(tool('new-bound', 'new'));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('waits for provider terminal output to associate args.done without a response ID', async () => {
    const h = setup();
    await h.configure();
    await h.start('source');
    h.provider(tool('call-1'));
    await settle();
    expect(execute).not.toHaveBeenCalled();
    h.provider({
      type: 'response.done',
      response: {
        id: 'source',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'create_notebook_note',
            arguments: '{"title":"复习"}',
          },
        ],
      },
    });
    await settle();
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      'secret',
      'user-1',
      'device-1',
      {
        call_id: 'call-1',
        name: 'create_notebook_note',
        raw_args: '{"title":"复习"}',
      },
      first.now
    );
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(2);
  });
  it('collects interleaved calls separately and creates one continuation after all receipts and terminal', async () => {
    const h = setup();
    await h.configure();
    await h.start('tools');
    const resolve: ((value: typeof receipt) => void)[] = [];
    execute.mockImplementation(() => new Promise(r => resolve.push(r)));
    for (const id of ['one', 'two'])
      h.provider({
        type: 'response.output_item.added',
        response_id: 'tools',
        item: { type: 'function_call', call_id: id, name: 'create_todo' },
      });
    h.provider({
      type: 'response.function_call_arguments.delta',
      call_id: 'one',
      delta: '{"title":',
    });
    h.provider({
      type: 'response.function_call_arguments.delta',
      call_id: 'two',
      delta: '{"title":"B"}',
    });
    h.provider({
      type: 'response.function_call_arguments.done',
      call_id: 'two',
    });
    h.provider({
      type: 'response.function_call_arguments.done',
      call_id: 'one',
      arguments: '{"title":"A"}',
    });
    expect(execute.mock.calls.map(c => c[4].raw_args)).toEqual([
      '{"title":"B"}',
      '{"title":"A"}',
    ]);
    resolve[0](receipt);
    await settle();
    h.provider({
      type: 'response.done',
      response: { id: 'tools', status: 'completed', output: [] },
    });
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    resolve[1](receipt);
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'conversation.item.create')
    ).toHaveLength(2);
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(2);
    h.provider({
      type: 'response.done',
      response: { id: 'tools', status: 'completed' },
    });
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(2);
  });
  it('retains an already admitted write receipt after cancellation without restarting generation', async () => {
    const h = setup();
    await h.configure();
    await h.start('writing');
    let resolve!: (value: typeof receipt) => void;
    execute.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    h.provider(tool('write', 'writing'));
    h.frame({ type: 'response.cancel' });
    resolve(receipt);
    await settle();
    const output = h.upstream
      .events()
      .find(e => e.type === 'conversation.item.create');
    expect(JSON.parse(output.item.output).data.note.id).toBe('saved-note');
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'tool.receipt',
        call_id: 'write',
        retired: true,
      })
    );
  });
  it('keeps failed terminal status and never continues a failed tool response', async () => {
    const h = setup();
    await h.configure();
    await h.start('failed');
    let resolve!: (value: typeof receipt) => void;
    execute.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    h.provider(tool('write', 'failed'));
    h.provider({
      type: 'response.done',
      response: { id: 'failed', status: 'incomplete' },
    });
    resolve(receipt);
    await settle();
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'turn.done', status: 'incomplete' })
    );
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
  });
  it('projects one text source when native text and audio transcript are both present', async () => {
    const h = setup();
    await h.configure();
    await h.start('text');
    h.provider({
      type: 'response.text.delta',
      response_id: 'text',
      delta: '答案',
    });
    h.provider({
      type: 'response.audio_transcript.delta',
      response_id: 'text',
      delta: '答案',
    });
    expect(
      h.device
        .events()
        .filter(e => e.type === 'text.delta')
        .map(e => e.delta)
        .join('')
    ).toBe('答案');
  });
  it('projects full text without requiring a delta and keeps transcript duplication out', async () => {
    const h = setup();
    await h.configure();
    await h.start('full');
    h.provider({
      type: 'response.text.done',
      response_id: 'full',
      text: '完整回答',
    });
    h.provider({
      type: 'response.audio_transcript.done',
      response_id: 'full',
      transcript: '重复朗读',
    });
    expect(
      h.device
        .events()
        .filter(e => e.type === 'text.complete')
        .map(e => e.text)
    ).toEqual(['完整回答']);
  });
  it('recovers terminal output text and sends a compact typed completion', async () => {
    const h = setup();
    await h.configure();
    await h.start('terminal');
    h.provider({
      type: 'response.done',
      response: {
        id: 'terminal',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '终态回答' }],
          },
        ],
      },
    });
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'text.complete', text: '终态回答' })
    );
    expect(h.device.events().at(-1)).toEqual({
      type: 'turn.done',
      status: 'completed',
      response_id: 'terminal',
      turn_id: 1,
    });
  });
  it('rejects a sequence gap and malformed PCM before committing a partial recording', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 3, final: true }),
      true
    );
    expect(h.device.readyState).toBe(3);
    expect(
      h.upstream.events().some(e => e.type === 'input_audio_buffer.commit')
    ).toBe(false);
  });
  it('bounds upstream socket backpressure instead of silently losing capture', async () => {
    const h = setup();
    await h.configure();
    h.upstream.bufferedAmount = 256 * 1024;
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
  });
  it('bounds a business-silent response even while device pings remain active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(first.now));
    const h = setup();
    await h.configure();
    await h.start('silent');
    for (let i = 0; i < 10; i++) {
      h.session.markDeviceActive();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(h.device.readyState).toBe(3);
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'error', stage: 'response-timeout' })
    );
  });
  it('does not use a no-response cancel error as confirmation of a pending create', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(first.now));
    const h = setup();
    await h.configure();
    h.frame({ type: 'response.create' });
    await settle();
    h.ack();
    await settle();
    h.frame({ type: 'response.cancel' });
    h.provider({
      type: 'error',
      error: { message: 'no ongoing response to cancel' },
    });
    h.frame({ type: 'response.create' });
    await settle();
    h.ack();
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10001);
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'error', stage: 'cancel' })
    );
    expect(h.device.readyState).toBe(3);
  });
  it('commits one contiguous recording and binds ASR to its acknowledged input item', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 2, final: true }),
      true
    );
    await settle();
    h.ack();
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'input_audio_buffer.commit')
    ).toHaveLength(1);
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    h.provider({ type: 'input_audio_buffer.committed', item_id: 'input-1' });
    h.provider({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-1',
      transcript: 'question',
    });
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ transcript: 'question', turn_id: 1 })
    );
    h.provider({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'old-input',
      transcript: 'stale',
    });
    expect(h.device.events().some(e => e.transcript === 'stale')).toBe(false);
  });
  it.each([{ sampleRate: 16000 }, { channels: 2 }, { pcm: Buffer.alloc(1) }])(
    'rejects incompatible PCM format %j before append',
    async bad => {
      const h = setup();
      await h.configure();
      h.session.onDeviceFrame(
        encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1, ...bad }),
        true
      );
      expect(
        h.upstream.events().some(e => e.type === 'input_audio_buffer.append')
      ).toBe(false);
      expect(h.device.readyState).toBe(3);
    }
  );
});
