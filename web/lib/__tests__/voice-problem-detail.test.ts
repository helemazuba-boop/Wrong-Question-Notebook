import { describe, it, expect, vi } from 'vitest';
import { buildAiToolExecutor } from '@/app/api/esp32/ai/transcribe-chat/v2-tools';
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from }),
}));
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('voice detail with real v2 reader projection', () => {
  it('reads a no-answer Problem with options, math, image completion and a usable WQN link', async () => {
    from.mockImplementation(table => {
      const q: any = {};
      q.select = q.eq = () => q;
      q.maybeSingle = async () => ({
        data:
          table === 'problems'
            ? {
                id,
                user_id: user,
                subject_id: id,
                title: 'Question',
                revision: 1,
                content: '<p>Stem</p>',
                solution_text: '',
                assets: [],
                solution_assets: [],
                source: {},
                parts: [
                  {
                    index: 1,
                    type: 'single_choice',
                    content: '<p><span data-latex="x^2"></span></p>',
                    mcq_choices: [
                      { id: 'A', text: 'first' },
                      { id: 'B', text: 'second' },
                    ],
                  },
                ],
              }
            : null,
        error: null,
      });
      q.then = (resolve: any) =>
        Promise.resolve({
          data: table === 'mcp_v2_user_actions' ? [{ id }] : [],
          error: null,
        }).then(resolve);
      return q;
    });
    const result = await buildAiToolExecutor({ userId: user })(
      'get_problem_detail',
      JSON.stringify({ problem_id: id })
    );
    expect(result.ok).toBe(true);
    expect((result.data as any).problem).toMatchObject({
      structure_complete: true,
      image_completion_required: true,
      parts: [
        {
          content_text: '$x^2$',
          mcq_choices: [
            { id: 'A', text: 'first' },
            { id: 'B', text: 'second' },
          ],
          correct_answer: null,
        },
      ],
      evidence: { answer_origin: null },
    });
    expect((result.data as any).problem.web_url).toContain(
      `/subjects/${id}/problems/${id}/review`
    );
  });
});
