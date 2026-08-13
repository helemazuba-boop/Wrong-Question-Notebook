import { describe, expect, it } from 'vitest';
import {
  buildSkillRetrievalQuery,
  parseSkillRetrievalQueryProblem,
} from '@/lib/problem-marks/retrieval/skill-query';

describe('Skill retrieval statement-only query', () => {
  it('projects only statement fields and visible choice text', () => {
    const query = buildSkillRetrievalQuery({
      title: '力学综合题',
      content: '光滑水平面上有两个滑块。',
      solution_text: '正确答案和解析不得进入检索。',
      assets: [{ secret: 'vision-answer' }],
      initial_idea: '个人想法不得进入检索。',
      parts: [
        {
          index: 1,
          type: 'mcq',
          label: '第一问',
          full_marks: 6,
          content: '滑块 A 受到的摩擦力方向是什么？',
          correct_answer: 'A',
          answer_config: {
            type: 'mcq',
            correct_choice_id: 'c1',
            choices: [
              { id: 'c1', text: '向左' },
              { id: 'c2', text: '向右' },
            ],
          },
        },
      ],
    });

    expect(query.templateVersion).toBe('skill-question-instruction-v1');
    expect(query.text).toContain('力学综合题');
    expect(query.text).toContain('光滑水平面上有两个滑块。');
    expect(query.text).toContain('滑块 A 受到的摩擦力方向是什么？');
    expect(query.text).toContain('Choice A: 向左');
    expect(query.text).toContain('Choice B: 向右');
    expect(query.text).not.toContain('正确答案');
    expect(query.text).not.toContain('解析');
    expect(query.text).not.toContain('correct_choice_id');
    expect(query.text).not.toContain('c1');
    expect(query.text).not.toContain('full_marks');
    expect(query.text).not.toContain('个人想法');
    expect(query.text).not.toContain('vision-answer');
  });

  it('rejects unknown part fields instead of serializing hidden structure', () => {
    expect(() =>
      parseSkillRetrievalQueryProblem({
        title: '力学题',
        parts: [
          {
            index: 1,
            content: '判断方向。',
            hidden_rubric: 'secret',
          },
        ],
      })
    ).toThrow();
  });
});
