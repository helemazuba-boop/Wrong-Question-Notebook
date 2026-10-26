import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';
import {
  AskQuestionSchema,
  createVoiceInteractionGateway,
} from '@/lib/ai-tools/voice-interaction';
import { runPipelineChat } from '@/lib/sse-pipeline-chat';
import { PipelinePusher } from '@/lib/sse-pipeline-types';
import { SseEventIdGenerator } from '@/lib/ai-stream';

const { write } = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/ai-tools/voice-write', async () => ({
  ...(await vi.importActual('@/lib/ai-tools/voice-write')),
  executeVoiceWrite: write,
}));
const ctx = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId: 'std_request_0001',
  timeContext: { now: '2026-10-26T00:00:00Z', timezone: 'Asia/Shanghai' },
  requireConfirmation: true,
};
beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue({
    todo: { id: 'created' },
    action: { type: 'todo_created' },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('STD decisions gate execution', () => {
  it.each(['create_todo', 'create_notebook_note', 'update_todo_status'])(
    'refuses %s without a device decision channel',
    async name => {
      const args =
        name === 'create_todo'
          ? { title: '复习' }
          : name === 'create_notebook_note'
            ? { notebook_id: ctx.userId, title: '笔记', content: '正文' }
            : { todo_id: ctx.userId, status: 'completed' };
      const result = await buildAiToolExecutor(ctx)(
        name,
        JSON.stringify(args),
        { callId: 'call' }
      );
      expect(result.error?.code).toBe('confirmation_required');
      expect(write).not.toHaveBeenCalled();
    }
  );
  it('waits for an explicit approval, and binds the exact parameters and original clock', async () => {
    let answer!: (value: string) => void;
    const ask = vi.fn(() => new Promise<string>(r => (answer = r)));
    const args = { title: '复习数学', due: { date: 'tomorrow' } };
    const pending = buildAiToolExecutor({ ...ctx, interaction: { ask } })(
      'create_todo',
      JSON.stringify(args),
      { callId: 'call' }
    );
    expect(write).not.toHaveBeenCalled();
    expect(ask.mock.calls[0][1]).toMatchObject({
      kind: 'write',
      allow_custom: false,
      command: { args, time: ctx.timeContext },
    });
    answer('approve');
    expect((await pending).ok).toBe(true);
    expect(write.mock.calls[0][2]).toEqual(args);
    expect(write.mock.calls[0][4]).toEqual(ctx.timeContext);
  });
  it.each(['reject', '__custom__'])('never mutates after %s', async answer => {
    const result = await buildAiToolExecutor({
      ...ctx,
      interaction: { ask: async () => answer },
    })('create_todo', '{"title":"复习"}', { callId: 'call' });
    expect(result.error?.code).toBe('user_cancelled');
    expect(write).not.toHaveBeenCalled();
  });
  it('a disconnect while confirmation is pending cannot start a write', async () => {
    const controller = new AbortController();
    const ask = vi.fn(async () => {
      controller.abort();
      return 'approve';
    });
    await buildAiToolExecutor({ ...ctx, interaction: { ask } })(
      'create_todo',
      '{"title":"复习"}',
      { callId: 'call', signal: controller.signal }
    );
    expect(write).not.toHaveBeenCalled();
  });
  it('ask_question returns the selected value to the model and preserves custom-answer interruption', async () => {
    const question = {
      question: '何时提醒？',
      options: [{ label: '早上九点', value: '09:00' }],
    };
    const ask = vi
      .fn()
      .mockResolvedValueOnce('09:00')
      .mockResolvedValueOnce('__custom__');
    const execute = buildAiToolExecutor({ ...ctx, interaction: { ask } });
    expect(
      await execute('ask_question', JSON.stringify(question), { callId: 'q1' })
    ).toMatchObject({ ok: true, data: { answer: '09:00' } });
    expect(
      await execute('ask_question', JSON.stringify(question), { callId: 'q2' })
    ).toMatchObject({ ok: false, error: { code: 'user_cancelled' } });
    expect(write).not.toHaveBeenCalled();
  });
  it('validates question choices before publishing a card', () => {
    for (const options of [
      [],
      Array.from({ length: 9 }, (_, i) => ({ label: 'x', value: String(i) })),
      [{ label: 'x', value: '__custom__' }],
      [
        { label: 'x', value: 'a' },
        { label: 'y', value: 'a' },
      ],
    ])
      expect(
        AskQuestionSchema.safeParse({ question: '问题', options }).success
      ).toBe(false);
  });
  it('cancelling one write stops later calls in the same model turn', async () => {
    const call = (id: string) => ({
      id,
      type: 'function',
      function: { name: 'create_todo', arguments: '{"title":"不要创建"}' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call('a'), call('b')].map((c, index) => ({ ...c, index })) }, finish_reason: 'tool_calls' }] })}\n\n`
          )
      )
    );
    const emit = vi.fn();
    const ask = vi.fn(async () => 'reject');
    const outcome = await runPipelineChat(
      {
        apiKey: 'fixture',
        baseUrl: 'https://fixture.invalid',
        model: 'fixture',
        systemPrompt: 'fixture',
        llmTimeoutMs: 1000,
        interactive: true,
      },
      { transcript: 'fixture' },
      new PipelinePusher(
        { emit } as any,
        new SseEventIdGenerator(),
        Date.now()
      ),
      buildAiToolExecutor({ ...ctx, interaction: { ask } })
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(outcome.actions).toEqual([]);
    expect(outcome.functionCalls).toHaveLength(1);
  });
});

describe('durable interaction waiter', () => {
  function harness() {
    const row = {
      id: ctx.userId,
      state: 'pending',
      answer: null as string | null,
      expires_at: new Date(Date.now() + 10000).toISOString(),
    };
    const update = vi.fn();
    const query: any = {};
    query.select = query.eq = () => query;
    query.maybeSingle = async () => ({ data: { ...row }, error: null });
    query.update = (args: any) => {
      update(args);
      return query;
    };
    const rpc = vi.fn(async () => ({ data: { ...row }, error: null }));
    const emit = vi.fn();
    const gateway = createVoiceInteractionGateway(
      { ...ctx, origin: '', supabase: { rpc, from: () => query } as any },
      ctx.requestId,
      { emit } as any,
      () => 10000
    );
    return { row, update, rpc, emit, gateway };
  }
  it('publishes a bounded request and heartbeat, then returns the durable answer', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.gateway.ask('call', {
      kind: 'question',
      prompt: '请选择',
      options: [{ label: '是', value: 'yes' }],
      allow_custom: true,
    });
    await Promise.resolve();
    expect(h.emit).toHaveBeenCalledWith(
      'interaction.request',
      expect.objectContaining({ interaction_id: ctx.userId })
    );
    h.row.state = 'answered';
    h.row.answer = 'yes';
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ answer: 'yes' });
    expect(h.update).toHaveBeenCalledWith({ state: 'cancelled' });
  });
  it('abandoning a pending stream cancels its decision and never returns approval', async () => {
    const h = harness(),
      controller = new AbortController();
    const pending = h.gateway.ask(
      'call',
      {
        kind: 'write',
        prompt: '执行？',
        options: [{ label: '执行', value: 'approve' }],
        allow_custom: false,
      },
      controller.signal
    );
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(h.update).toHaveBeenCalled();
  });
});
