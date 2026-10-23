import { EventEmitter } from 'events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RelaySession } from '@/server/realtime-proxy/src/voiceRelay';
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
  sent: string[] = [];
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.readyState = 3;
  }
  ping() {}
}
const first = {
  now: '2026-10-14T12:00:00Z',
  timezone: 'Asia/Shanghai',
  notebooks: [{ id: 'notebook-1', title: '数学', subject_name: '数学' }],
  notebooks_available: true,
  notebooks_truncated: false,
};
const sessions: RelaySession[] = [];
function setup() {
  const device = new Socket(),
    upstream = new Socket();
  context.mockResolvedValue(first);
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
  return {
    session,
    device,
    upstream,
    frame: (value: unknown) =>
      session.onDeviceFrame(Buffer.from(JSON.stringify(value)), false),
  };
}
async function settle() {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.shutdown('test-end');
  vi.clearAllMocks();
});
describe('Flash trusted context ordering', () => {
  it('injects notebook IDs and eight tools during session initialization', async () => {
    const h = setup();
    h.frame({
      type: 'session.update',
      session: { instructions: 'base', tools: [] },
    });
    await settle();
    const update = JSON.parse(h.upstream.sent[0]);
    expect(update.session.tools).toHaveLength(8);
    expect(update.session.instructions).toContain('notebook-1');
    expect(update.session.instructions).toContain(first.now);
    expect(h.device.sent.map(s => JSON.parse(s))).toContainEqual({
      type: 'state',
      stage: 'session.negotiated',
    });
  });
  it('refreshes the local calendar before starting each user response', async () => {
    const h = setup();
    h.frame({ type: 'session.update', session: { instructions: 'base' } });
    await settle();
    context.mockResolvedValue({ ...first, now: '2026-10-15T16:00:00Z' });
    h.frame({ type: 'response.create' });
    await settle();
    const sent = h.upstream.sent.map(s => JSON.parse(s));
    expect(sent.at(-2).session.instructions).toContain('2026-10-16');
    expect(sent.at(-1)).toEqual({ type: 'response.create' });
  });
  it('drops a cancelled response while the context request is pending', async () => {
    const h = setup();
    let resolve!: (value: any) => void;
    context.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    h.frame({ type: 'response.create' });
    await settle();
    h.frame({ type: 'response.cancel' });
    resolve(first);
    await settle();
    expect(h.upstream.sent.map(s => JSON.parse(s).type)).toEqual([
      'response.cancel',
    ]);
  });
  it('does not start a response with unavailable context', async () => {
    const h = setup();
    context.mockRejectedValue(new Error('context down'));
    h.frame({ type: 'response.create' });
    await settle();
    expect(h.upstream.sent).toEqual([]);
    expect(JSON.parse(h.device.sent[0]).type).toBe('error');
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
    h.frame({ type: 'input_audio_buffer.commit' });
    h.session.onDeviceFrame(Buffer.alloc(800), true);
    expect(h.upstream.sent).toEqual([]);
  });
  it('closes both transports when initial context fails, even if error delivery throws', async () => {
    const h = setup();
    context.mockRejectedValue(new Error('context denied'));
    h.device.send = () => {
      throw new Error('device gone');
    };
    h.frame({ type: 'session.update', session: {} });
    await settle();
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
    h.frame({ type: 'conversation.item.create', item: {} });
    expect(h.upstream.sent).toEqual([]);
  });
  it('does not send a late successful configuration after context failure closed the session', async () => {
    const h = setup();
    let resolve!: (value: any) => void;
    context
      .mockReturnValueOnce(
        new Promise(r => {
          resolve = r;
        })
      )
      .mockRejectedValueOnce(new Error('account disabled'));
    h.frame({ type: 'session.update', session: {} });
    h.frame({ type: 'session.update', session: {} });
    await settle();
    resolve(first);
    await settle();
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.sent).toEqual([]);
  });
  it('cannot cancel a pending context denial to keep forwarding', async () => {
    const h = setup();
    let reject!: (error: Error) => void;
    context.mockReturnValueOnce(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      })
    );
    h.frame({ type: 'response.create' });
    await settle();
    h.frame({ type: 'response.cancel' });
    reject(new Error('account disabled'));
    await settle();
    expect(h.device.readyState).toBe(3);
    expect(h.upstream.readyState).toBe(3);
    const previous = [...h.upstream.sent];
    h.frame({ type: 'input_audio_buffer.commit' });
    h.session.onDeviceFrame(Buffer.alloc(800), true);
    expect(h.upstream.sent).toEqual(previous);
  });
  it('keeps the original clock through tool continuation', async () => {
    const h = setup();
    h.frame({ type: 'session.update', session: { instructions: 'base' } });
    await settle();
    execute.mockResolvedValue({
      ok: true,
      display: 'Todo created',
      data: {},
      action: null,
    });
    h.session.onUpstreamFrame(
      Buffer.from(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'call-1',
          name: 'create_todo',
          arguments: '{"title":"复习"}',
        })
      ),
      false
    );
    await settle();
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      'secret',
      'user-1',
      'device-1',
      { call_id: 'call-1', name: 'create_todo', raw_args: '{"title":"复习"}' },
      first.now
    );
    expect(context).toHaveBeenCalledTimes(1);
    expect(h.device.sent.map(s => JSON.parse(s))).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        ok: true,
        tool_call_id: 'call-1',
        display: 'Todo created',
      })
    );
  });
  it('emits a firmware-readable failure event with its error code', async () => {
    const h = setup();
    execute.mockResolvedValue({
      ok: false,
      display: 'Writing note failed',
      action: null,
      error: {
        code: 'notebook_permission_denied',
        message: '请检查笔记本授权',
      },
    });
    h.session.onUpstreamFrame(
      Buffer.from(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'failed-note',
          name: 'create_notebook_note',
          arguments: '{}',
        })
      ),
      false
    );
    await settle();
    expect(h.device.sent.map(s => JSON.parse(s))).toContainEqual(
      expect.objectContaining({
        type: 'tool.error',
        ok: false,
        tool_call_id: 'failed-note',
        error: {
          code: 'notebook_permission_denied',
          message: '请检查笔记本授权',
        },
      })
    );
  });
  it('keeps a late write receipt without restarting a cancelled response', async () => {
    const h = setup();
    let resolve!: (value: any) => void;
    execute.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    h.session.onUpstreamFrame(
      Buffer.from(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'cancelled-write',
          name: 'create_notebook_note',
          arguments: '{}',
        })
      ),
      false
    );
    h.frame({ type: 'response.cancel' });
    resolve({
      ok: true,
      display: 'Note saved',
      data: { note: { id: 'saved-note' } },
      action: null,
    });
    await settle();
    const sent = h.upstream.sent.map(s => JSON.parse(s));
    expect(sent.map(s => s.type)).toEqual([
      'response.cancel',
      'conversation.item.create',
    ]);
    expect(JSON.parse(sent[1].item.output)).toMatchObject({
      ok: true,
      data: { note: { id: 'saved-note' } },
    });
    expect(h.device.sent.map(s => JSON.parse(s).type)).not.toContain(
      'tool.result'
    );
  });
});
