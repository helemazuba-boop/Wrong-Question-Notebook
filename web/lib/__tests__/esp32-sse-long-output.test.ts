import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runPipelineChat } from '@/lib/sse-pipeline-chat';
afterEach(() => vi.unstubAllGlobals());
import { SseEventIdGenerator, SseWriter } from '@/lib/ai-stream';
import { PipelinePusher } from '@/lib/sse-pipeline-types';

function harness() {
  const wire: string[] = [];
  const ids = new SseEventIdGenerator(0);
  const writer = new SseWriter(
    {
      enqueue: (bytes: Uint8Array) =>
        wire.push(new TextDecoder().decode(bytes)),
    } as any,
    ids
  );
  const pusher = new PipelinePusher(writer, ids, Date.now());
  const events = () =>
    wire.map(frame => ({
      event: /^event: (.*)$/m.exec(frame)![1],
      id: Number(/^id: (.*)$/m.exec(frame)![1]),
      data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]),
    }));
  return { wire, pusher, events };
}
const final = (reply_text: string) => ({
  success: true as const,
  conversation_id: 'fixture',
  latency_ms: 1,
  transcript: 'reviewed input',
  reply_text,
  actions: [],
  function_calls: [],
  status_trace: [],
});
const long = '这是持续输出的内容。🚀 "quoted" \\line\n'.repeat(5000);
function deviceCompatible(wire: string[]) {
  for (const frame of wire) {
    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    for (const line of frame.split('\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  }
}
describe('ESP32 long SSE output contract', () => {
  it('streams long thinking losslessly and ends without oversized full_text', () => {
    const h = harness();
    h.pusher.emitThinkingStart();
    h.pusher.emitThinkingDelta(long);
    h.pusher.emitThinkingDone(long);
    deviceCompatible(h.wire);
    const events = h.events();
    expect(
      events
        .filter(e => e.event === 'thinking.delta')
        .map(e => e.data.delta)
        .join('')
    ).toBe(long);
    expect(events.at(-1)!.event).toBe('thinking.done');
    expect(events.at(-1)!.data.full_text).toBe('');
    expect(events.map(e => e.id)).toEqual(events.map((_, i) => i));
  });
  it('preserves long answer deltas and reaches a bounded successful final', () => {
    const h = harness();
    h.pusher.appendDelta(long);
    h.pusher.closeSentence();
    h.pusher.emitFinal(final(long));
    deviceCompatible(h.wire);
    const events = h.events();
    expect(
      events
        .filter(e => e.event === 'text.delta')
        .map(e => e.data.delta)
        .join('')
    ).toBe(long);
    expect(events.find(e => e.event === 'text.end')!.data.full_text).toBe('');
    expect(events.at(-1)!.data).toMatchObject({
      success: true,
      reply_text: '',
      conversation_id: 'fixture',
    });
  });
  it('keeps short authoritative terminal text unchanged', () => {
    const h = harness();
    h.pusher.appendDelta('stream');
    h.pusher.closeSentence();
    h.pusher.emitFinal(final('authoritative correction'));
    expect(h.events().at(-1)!.data.reply_text).toBe('authoritative correction');
  });
  it('does not silently omit oversized authoritative content that never streamed', () => {
    const h = harness();
    expect(() => h.pusher.emitFinal(final(long))).toThrow();
    expect(h.events().some(e => e.event === 'final')).toBe(false);
  });
  it('does not alter or drop authority-bearing tool receipts to make them fit', () => {
    const h = harness();
    expect(() =>
      h.pusher.emitToolResult({
        tool_call_id: 't',
        name: 'fixture',
        ok: true,
        display: long,
      })
    ).toThrow();
    expect(h.events().some(e => e.event === 'tool.result')).toBe(false);
  });
  it('retains bounded receipts and refuses an oversized final receipt even after text was streamed', () => {
    const h = harness();
    h.pusher.appendDelta(long);
    h.pusher.closeSentence();
    const payload = { ...final(long), actions: [{ receipt: long }] };
    expect(() => h.pusher.emitFinal(payload)).toThrow();
    expect(h.events().some(e => e.event === 'final')).toBe(false);
  });
  it('rejects a long thinking correction that does not match streamed reasoning', () => {
    const h = harness();
    h.pusher.emitThinkingStart();
    h.pusher.emitThinkingDelta(long);
    expect(() => h.pusher.emitThinkingDone(long + 'correction')).toThrow();
    expect(h.events().some(e => e.event === 'thinking.done')).toBe(false);
  });
  it('keeps thinking/text/tool order and produces a native-device replay fixture', () => {
    const h = harness();
    h.pusher.emitReady({
      turn_id: 'fixture',
      conversation_id: 'fixture',
      ai_tier: 'std',
      started_at_ms: 0,
    });
    h.pusher.emitThinkingStart();
    h.pusher.emitThinkingDelta(long);
    h.pusher.emitThinkingDone(long);
    h.pusher.appendDelta(long);
    h.pusher.closeSentence();
    h.pusher.emitToolStart('t', 'fixture', 0);
    h.pusher.emitToolResult({
      tool_call_id: 't',
      name: 'fixture',
      ok: true,
      display: 'accepted fixture receipt',
    });
    h.pusher.appendDelta('after tool');
    h.pusher.closeSentence();
    h.pusher.emitFinal(final(long + 'after tool'));
    deviceCompatible(h.wire);
    expect(
      h.events().filter(e => e.event === 'tool.result')[0].data.display
    ).toBe('accepted fixture receipt');
    expect(h.events().at(-1)!.data.reply_text).toBe('');
    if (process.env.WQN_TEST_SSE_WIRE_OUTPUT)
      writeFileSync(process.env.WQN_TEST_SSE_WIRE_OUTPUT, h.wire.join(''));
  });
  it('carries long StepFun-style reasoning and content through the production provider consumer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [
              { choices: [{ delta: { reasoning: long } }] },
              {
                choices: [{ delta: { content: long }, finish_reason: 'stop' }],
              },
            ]
              .map(event => `data: ${JSON.stringify(event)}\n\n`)
              .join('') + 'data: [DONE]\n\n'
          )
      )
    );
    const h = harness();
    const result = await runPipelineChat(
      {
        apiKey: 'synthetic',
        baseUrl: 'http://provider.test',
        model: 'step-5-preview',
        llmTimeoutMs: 10000,
        systemPrompt: 'fixture',
      },
      { transcript: 'fixture' },
      h.pusher
    );
    h.pusher.emitFinal(final(result.replyText));
    deviceCompatible(h.wire);
    expect(result.replyText).toBe(long);
    expect(
      h
        .events()
        .filter(e => e.event === 'thinking.delta')
        .map(e => e.data.delta)
        .join('')
    ).toBe(long);
    expect(h.events().at(-1)!.data.reply_text).toBe('');
  });
});
