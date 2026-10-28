import { EventEmitter } from 'events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RelaySession } from '@/server/realtime-proxy/src/voiceRelay';
import { encodeWflvAudio } from '@/server/realtime-proxy/src/frameIo';
import { assertFlashControl } from '@/lib/test/flash-contract';
import { log } from '@/server/realtime-proxy/src/logger';
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
      .map(s => {
        const event = JSON.parse(s);
        assertFlashControl(event);
        return event;
      });
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
function setup(upstreamUrl = 'wss://api.stepfun.com/v1/realtime') {
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
      upstream: {
        url: upstreamUrl,
        apiKey: '',
        model: 'stepaudio-3-realtime-preview',
      },
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
  it('binds the latest cumulative ASR snapshot at commit and never appends revisions or overwrites completed text', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    const partial = (delta: string) =>
      h.provider({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'input-snapshot',
        delta,
      });
    partial('明天');
    partial('明天上午九');
    partial('明天上午 9 点');
    expect(
      h.device.events().filter(e => e.type === 'asr.partial')
    ).toHaveLength(0);
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 2, final: true }),
      true
    );
    await settle();
    const turn = h.device
      .events()
      .find(e => e.type === 'turn.started')!.turn_id;
    h.provider({
      type: 'input_audio_buffer.committed',
      item_id: 'input-snapshot',
    });
    partial('明天上午 9 点提醒我');
    const events = h.device.events().filter(e => e.type === 'asr.partial');
    expect(events).toEqual([
      { type: 'asr.partial', text: '明天上午 9 点', turn_id: turn },
      { type: 'asr.partial', text: '明天上午 9 点提醒我', turn_id: turn },
    ]);
    h.provider({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-snapshot',
      transcript: '最终文本',
    });
    partial('迟到旧片段');
    expect(
      h.device.events().filter(e => e.type === 'asr.partial')
    ).toHaveLength(2);
  });

  it('retains early completed ASR and discards cancelled pre-commit snapshots', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    h.provider({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'old-input',
      delta: '旧文本',
    });
    h.frame({ type: 'response.cancel' });
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 2 }),
      true
    );
    h.provider({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new-input',
      transcript: '新完整文本',
    });
    h.provider({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'new-input',
      delta: '不能降级为片段',
    });
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 3, final: true }),
      true
    );
    await settle();
    h.provider({ type: 'input_audio_buffer.committed', item_id: 'new-input' });
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '新完整文本',
      })
    );
    expect(h.device.events().some(e => e.type === 'asr.partial')).toBe(false);
    expect(JSON.stringify(h.device.events())).not.toContain('旧文本');
  });

  it('bounds unbound ASR items and truncates long UTF-8 previews without failing the recording', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    h.provider({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'long-input',
      delta: '中'.repeat(4000),
    });
    expect(h.device.readyState).toBe(1);
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 2, final: true }),
      true
    );
    await settle();
    h.provider({ type: 'input_audio_buffer.committed', item_id: 'long-input' });
    const partial = h.device.events().find(e => e.type === 'asr.partial')!;
    expect(Buffer.byteLength(partial.text)).toBeLessThanOrEqual(8192);
    expect(partial.text).toContain('显示已截断');
    expect(partial.text).not.toContain('\uFFFD');
    const bounded = setup();
    await bounded.configure();
    bounded.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 1 }),
      true
    );
    for (let i = 0; i < 9; i++)
      bounded.provider({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: `input-${i}`,
        delta: 'x',
      });
    expect(bounded.device.readyState).toBe(3);
    expect(bounded.device.events()).toContainEqual(
      expect.objectContaining({ type: 'error', stage: 'asr' })
    );
  });

  it('clears cancelled uncommitted audio while preserving the connection sequence and rejects an empty new FINAL', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720), seq: 40 }),
      true
    );
    h.frame({ type: 'response.cancel' });
    expect(
      h.upstream.events().filter(e => e.type === 'input_audio_buffer.clear')
    ).toHaveLength(1);
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 41, final: true }),
      true
    );
    expect(
      h.upstream.events().filter(e => e.type === 'input_audio_buffer.commit')
    ).toHaveLength(0);
    expect(h.device.readyState).toBe(3);
  });

  it('appends only a fresh recording after cancel/clear and commits it once', async () => {
    const h = setup();
    await h.configure();
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720, 1), seq: 40 }),
      true
    );
    h.frame({ type: 'response.cancel' });
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(720, 2), seq: 41 }),
      true
    );
    h.session.onDeviceFrame(
      encodeWflvAudio({ pcm: Buffer.alloc(0), seq: 42, final: true }),
      true
    );
    await settle();
    h.ack();
    await settle();
    const events = h.upstream.events();
    const cleared = events.findIndex(
      e => e.type === 'input_audio_buffer.clear'
    );
    const nextAppend = events.findIndex(
      (e, index) => index > cleared && e.type === 'input_audio_buffer.append'
    );
    expect(Buffer.from(events[nextAppend].audio, 'base64')).toEqual(
      Buffer.alloc(720, 2)
    );
    expect(
      events.filter(e => e.type === 'input_audio_buffer.commit')
    ).toHaveLength(1);
    expect(h.device.readyState).toBe(1);
  });

  it.each(['client_vad', '', 'semantic_vad', 'x'.repeat(80)])(
    'logs the bounded actual turn type rather than typeof: %j',
    async type => {
      const warning = vi.spyOn(log, 'warn');
      try {
        const h = setup();
        h.frame({ type: 'session.update', session: {} });
        await settle();
        h.provider({
          type: 'session.updated',
          session: {
            ...h.upstream.events()[0].session,
            input_audio_format: 'incompatible-format',
            turn_detection: { type },
          },
        });
        const entry = warning.mock.calls.find(
          ([message]) => message === 'Flash provider configuration ACK mismatch'
        );
        expect(entry?.[1]).toEqual(
          expect.objectContaining({
            turnDetectionType: type.slice(0, 64),
            turnDetectionTypeTruncated: type.length > 64,
          })
        );
        expect(JSON.stringify(entry)).not.toContain(
          h.upstream.events()[0].session.instructions
        );
        expect(h.device.events().some(e => e.type === 'session.ready')).toBe(
          false
        );
      } finally {
        warning.mockRestore();
      }
    }
  );

  it('accepts the documented StepFun manual ACK shape without turn_detection on initial and per-turn updates', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.frame({
      type: 'session.update',
      wqn: { playback_epoch: 1 },
      session: {},
    });
    await settle();
    const firstUpdate = h.upstream.events().at(-1);
    expect(firstUpdate.session.turn_detection).toBeNull();
    // StepFun's session response example omits the optional disabled VAD field.
    const reply = (instructions: string) => ({
      type: 'session.updated',
      session: {
        modalities: ['text', 'audio'],
        instructions,
        voice: 'qingchunshaonv',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        max_response_output_tokens: 4096,
      },
    });
    h.provider(reply(firstUpdate.session.instructions));
    await settle();
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({ type: 'session.ready' })
    );
    context.mockResolvedValueOnce({ ...first, now: '2026-10-14T12:01:00Z' });
    h.frame({ type: 'response.create' });
    await settle();
    const next = h.upstream
      .events()
      .filter(e => e.type === 'session.update')
      .at(-1);
    expect(next.session.instructions).not.toBe(
      firstUpdate.session.instructions
    );
    h.provider(reply(firstUpdate.session.instructions));
    await settle();
    expect(h.upstream.events().some(e => e.type === 'response.create')).toBe(
      false
    );
    h.provider(reply(next.session.instructions));
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30001);
    expect(h.device.readyState).toBe(1);
  });

  it('accepts the live-observed StepAudio 3 empty-string type and requires the current instructions', async () => {
    const h = setup();
    h.frame({
      type: 'session.update',
      wqn: { playback_epoch: 1 },
      session: {},
    });
    await settle();
    const update = h.upstream.events()[0];
    expect(update.session.turn_detection).toBeNull();
    h.provider({
      type: 'session.updated',
      session: {
        ...update.session,
        turn_detection: { type: '' },
        instructions: 'old',
      },
    });
    await settle();
    expect(h.device.events().some(e => e.type === 'session.ready')).toBe(false);
    h.provider({
      type: 'session.updated',
      session: { ...update.session, turn_detection: { type: '' } },
    });
    await settle();
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'session.ready',
        wqn: { playback_epoch: 1, turn_detection: 'manual' },
      })
    );
  });

  it.each([
    'wss://provider.invalid/v1/realtime',
    'wss://api.stepfun.com.invalid/v1/realtime',
    'wss://api.stepfun.com/other',
  ])(
    'does not infer default-off VAD from an omitted field for another endpoint: %s',
    async url => {
      const h = setup(url);
      h.frame({ type: 'session.update', session: {} });
      await settle();
      const { turn_detection: _disabled, ...reply } =
        h.upstream.events()[0].session;
      h.provider({ type: 'session.updated', session: reply });
      h.provider({
        type: 'session.updated',
        session: { ...reply, turn_detection: { type: '' } },
      });
      await settle();
      expect(h.device.events().some(e => e.type === 'session.ready')).toBe(
        false
      );
      h.ack();
      await settle();
      expect(h.device.events().some(e => e.type === 'session.ready')).toBe(
        true
      );
    }
  );

  it('requires the matching instructions echo when the disabled VAD field is omitted', async () => {
    const h = setup();
    h.frame({ type: 'session.update', session: {} });
    await settle();
    const formats = {
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
    };
    h.provider({ type: 'session.updated', session: formats });
    h.provider({
      type: 'session.updated',
      session: { ...formats, instructions: 'stale profile' },
    });
    await settle();
    expect(h.device.events().some(e => e.type === 'session.ready')).toBe(false);
    h.ack();
    await settle();
    expect(h.device.events().some(e => e.type === 'session.ready')).toBe(true);
  });

  it.each([
    { type: 'server_vad' },
    {},
    { type: '', enabled: true },
    { type: ' ' },
    [],
    false,
    'none',
    0,
  ])(
    'does not reinterpret an explicit incompatible VAD value as omitted: %j',
    async turn_detection => {
      const h = setup();
      h.frame({ type: 'session.update', session: {} });
      await settle();
      h.provider({
        type: 'session.updated',
        session: { ...h.upstream.events()[0].session, turn_detection },
      });
      await settle();
      expect(h.device.events().some(e => e.type === 'session.ready')).toBe(
        false
      );
      h.ack();
      await settle();
      expect(h.device.events().some(e => e.type === 'session.ready')).toBe(
        true
      );
    }
  );

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
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error_code: 'upstream_unavailable',
        stage: 'configuration',
        message: '模型配置确认超时，请重新连接',
      })
    );
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

  it('executes two explicit call IDs sharing the live-observed coarse item ID, without guessing item-only fragments', async () => {
    const h = setup();
    await h.configure();
    await h.start('shared-items');
    const finish: ((value: typeof receipt) => void)[] = [];
    execute.mockImplementation(
      () => new Promise(resolve => finish.push(resolve))
    );
    for (const call_id of ['call-0', 'call-1'])
      h.provider({
        type: 'response.output_item.added',
        response_id: 'shared-items',
        item: {
          type: 'function_call',
          id: 'item_coarse_timestamp',
          call_id,
          name: 'create_todo',
        },
      });
    h.provider({
      type: 'response.function_call_arguments.delta',
      item_id: 'item_coarse_timestamp',
      arguments: 'unassignable',
    });
    for (const [call_id, title] of [
      ['call-0', 'A'],
      ['call-1', 'B'],
    ])
      h.provider({
        type: 'response.function_call_arguments.done',
        response_id: 'shared-items',
        item_id: 'item_coarse_timestamp',
        call_id,
        name: 'create_todo',
        arguments: JSON.stringify({ title }),
      });
    expect(execute.mock.calls.map(c => c[4].raw_args)).toEqual([
      '{"title":"A"}',
      '{"title":"B"}',
    ]);
    h.provider({
      type: 'response.done',
      response: { id: 'shared-items', status: 'completed', output: [] },
    });
    finish[1](receipt);
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(1);
    finish[0](receipt);
    await settle();
    expect(
      h.upstream.events().filter(e => e.type === 'response.create')
    ).toHaveLength(2);
    expect(
      h.device.events().filter(e => e.type === 'tool.result')
    ).toHaveLength(2);
  });

  it('sends one cancel before response.created and tolerates its late no-op error after terminal without closing the new turn', async () => {
    const h = setup();
    await h.configure();
    h.frame({ type: 'response.create' });
    await settle();
    h.ack();
    await settle();
    h.frame({ type: 'response.cancel' });
    h.frame({ type: 'response.create' });
    await settle();
    h.ack();
    await settle();
    h.provider({ type: 'response.created', response: { id: 'retired' } });
    expect(
      h.upstream.events().filter(e => e.type === 'response.cancel')
    ).toHaveLength(1);
    h.provider({
      type: 'response.done',
      response: { id: 'retired', status: 'incomplete' },
    });
    h.provider({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'no ongoing response to cancel',
      },
    });
    expect(h.device.readyState).toBe(1);
    h.provider({ type: 'response.created', response: { id: 'recovered' } });
    h.provider({
      type: 'response.text.delta',
      response_id: 'recovered',
      delta: 'new answer',
    });
    h.provider({
      type: 'response.done',
      response: { id: 'recovered', status: 'completed' },
    });
    expect(h.device.events()).toContainEqual(
      expect.objectContaining({
        type: 'turn.done',
        status: 'completed',
        response_id: 'recovered',
      })
    );
  });

  it('does not keep the benign cancel-error allowance open beyond its bounded window', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.configure();
    await h.start('cancelled');
    h.frame({ type: 'response.cancel' });
    h.provider({
      type: 'response.done',
      response: { id: 'cancelled', status: 'incomplete' },
    });
    await vi.advanceTimersByTimeAsync(10001);
    h.provider({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'no ongoing response to cancel',
      },
    });
    expect(h.device.readyState).toBe(3);
  });
  it('binds item-only argument events and accepts the documented arguments fragment field', async () => {
    const h = setup();
    await h.configure();
    await h.start('items');
    h.provider({
      type: 'response.function_call_arguments.delta',
      response_id: 'items',
      item_id: 'unknown',
      delta: '{}',
    });
    expect(h.device.readyState).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    h.provider({
      type: 'response.output_item.added',
      response_id: 'items',
      item: {
        id: 'item-1',
        type: 'function_call',
        call_id: 'call-item',
        name: 'create_todo',
      },
    });
    h.provider({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      arguments: '{"title":"A"}',
    });
    h.provider({
      type: 'response.function_call_arguments.done',
      item_id: 'item-1',
    });
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][4]).toEqual({
      call_id: 'call-item',
      name: 'create_todo',
      raw_args: '{"title":"A"}',
    });
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
