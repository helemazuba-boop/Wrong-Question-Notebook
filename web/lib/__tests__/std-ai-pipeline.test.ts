import { beforeEach, describe, expect, it, vi } from 'vitest';
const { asr, chat } = vi.hoisted(() => ({ asr: vi.fn(), chat: vi.fn() }));
vi.mock('@/lib/sse-pipeline-asr', () => ({ runPipelineAsr: asr }));
vi.mock('@/lib/sse-pipeline-chat', () => ({ runPipelineChat: chat }));
import { runStreamingPipeline } from '@/lib/sse-pipeline';

beforeEach(() => {
  vi.clearAllMocks();
  asr.mockResolvedValue({
    transcript: 'recognized',
    provider: 'stepfun',
    model: 'asr',
    elapsedMs: 1,
  });
  chat.mockResolvedValue({
    replyText: 'reply',
    conversationId: 'conversation',
    actions: [],
    functionCalls: [],
  });
});
function options(confirmedText?: string) {
  return {
    writer: { emit: vi.fn() },
    input: {
      audio: new ArrayBuffer(2),
      confirmedText,
      tier: 'std',
      interactive: true,
    },
    asrProvider: 'stepfun',
    asrTimeoutMs: 1000,
    llmTimeoutMs: 1000,
    chatModelStd: 'fixture',
    systemPrompt: 'fixture',
  } as any;
}
describe('confirmed STD text pipeline', () => {
  it('uses the reviewed text directly without transcribing again', async () => {
    const request = options('用户实际确认的文字');
    const result = await runStreamingPipeline(request);
    expect(asr).not.toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ interactive: true });
    expect(chat.mock.calls[0][1]).toMatchObject({
      transcript: '用户实际确认的文字',
      tier: 'std',
    });
    expect(result.transcript).toBe('用户实际确认的文字');
    expect(request.writer.emit).toHaveBeenCalledWith(
      'final',
      expect.objectContaining({ transcript: '用户实际确认的文字' })
    );
  });
  it('retains ASR for the legacy audio entrypoint', async () => {
    const result = await runStreamingPipeline(options());
    expect(asr).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0][1]).toMatchObject({ transcript: 'recognized' });
    expect(result.transcript).toBe('recognized');
  });
});
