import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPipelineChat } from '@/lib/sse-pipeline-chat';
import { PipelinePusher } from '@/lib/sse-pipeline-types';
import { SseEventIdGenerator } from '@/lib/ai-stream';

afterEach(() => vi.unstubAllGlobals());
describe('voice tool round limit', () => {
  it('narrates the fourth tool receipt without permitting another mutation', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const toolsEnabled = Boolean(body.tools);
      const delta = toolsEnabled
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${fetcher.mock.calls.length}`,
                type: 'function',
                function: { name: 'create_notebook_note', arguments: '{}' },
              },
            ],
          }
        : { content: '四条笔记均已保存。' };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolsEnabled ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const executor = vi.fn(async (_name, _args, meta) => ({
      ok: true,
      display: 'Note saved',
      action: { type: 'notebook_note_created', note_id: meta.callId },
    }));
    const emit = vi.fn();
    const result = await runPipelineChat(
      {
        apiKey: 'test',
        baseUrl: 'http://provider.test',
        model: 'test',
        llmTimeoutMs: 1000,
        systemPrompt: 'test',
      },
      { transcript: '保存四条笔记' },
      new PipelinePusher(
        { emit } as any,
        new SseEventIdGenerator(),
        Date.now()
      ),
      executor
    );
    expect(executor).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fetcher.mock.calls[4][1].body).tools).toBeUndefined();
    expect(result.actions).toHaveLength(4);
    expect(
      result.functionCalls.every(call => call.status === 'succeeded')
    ).toBe(true);
    expect(result.replyText).toBe('四条笔记均已保存。');
  });
});
