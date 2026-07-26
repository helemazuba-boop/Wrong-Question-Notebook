import { describe, it, expect } from 'vitest';
import {
  ProblemPartsSchema,
  StoredProblemPartsSchema,
  ProblemSourceSchema,
  CreateProblemDto,
} from '@/lib/schemas';
import {
  markPart,
  markProblem,
  multiChoiceCreditRatio,
  isPartAutoMarkable,
  problemHasAutoMark,
} from '@/lib/answer-marking';
import type { MultiMCQAnswerConfig, ProblemPart } from '@/lib/types';

// ---------------------------------------------------------------------------
// Shell shape (gaokao problem shell: 1..10 typed parts, one nesting level)
// ---------------------------------------------------------------------------

const choices = [
  { id: 'A', text: '' },
  { id: 'B', text: '' },
  { id: 'C', text: '' },
  { id: 'D', text: '' },
];

describe('ProblemPartsSchema', () => {
  it('accepts a minimal single-part shell', () => {
    const parsed = ProblemPartsSchema.safeParse([
      { index: 1, type: 'short_answer' },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('accepts a mixed shell (biology-style nested types)', () => {
    const parsed = ProblemPartsSchema.safeParse([
      {
        index: 1,
        type: 'single_choice',
        label: '(1)',
        full_marks: 2,
        answer_config: {
          type: 'mcq',
          choices,
          correct_choice_id: 'B',
        },
      },
      { index: 2, type: 'fill_blank', label: '(2)', full_marks: 4 },
      { index: 3, type: 'short_answer', label: '(3)', full_marks: 6 },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty shell', () => {
    expect(ProblemPartsSchema.safeParse([]).success).toBe(false);
  });

  it('rejects more than 10 parts', () => {
    const parts = Array.from({ length: 11 }, (_, i) => ({
      index: i + 1,
      type: 'fill_blank',
    }));
    expect(ProblemPartsSchema.safeParse(parts).success).toBe(false);
  });

  it('rejects non-contiguous indexes', () => {
    const parsed = ProblemPartsSchema.safeParse([
      { index: 1, type: 'short_answer' },
      { index: 3, type: 'short_answer' },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown part types', () => {
    expect(
      ProblemPartsSchema.safeParse([{ index: 1, type: 'mcq' }]).success
    ).toBe(false);
  });

  it('rejects unknown answer_config shapes on write', () => {
    const parsed = ProblemPartsSchema.safeParse([
      {
        index: 1,
        type: 'short_answer',
        answer_config: { type: 'word_mistake', word_entry_id: 'x' },
      },
    ]);
    expect(parsed.success).toBe(false);
  });
});

describe('StoredProblemPartsSchema', () => {
  it('tolerates the word_mistake projection metadata riding answer_config', () => {
    const parsed = StoredProblemPartsSchema.safeParse([
      {
        index: 1,
        type: 'short_answer',
        correct_answer: 'ephemeral',
        answer_config: { type: 'word_mistake', word_entry_id: 'x' },
      },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('still enforces the shell structure', () => {
    expect(
      StoredProblemPartsSchema.safeParse([{ index: 2, type: 'essay' }]).success
    ).toBe(false);
  });
});

describe('ProblemSourceSchema', () => {
  it('accepts full gaokao provenance', () => {
    const parsed = ProblemSourceSchema.safeParse({
      year: 2024,
      paper: '新课标 I 卷',
      exam_type: 'real',
      question_no: 'T19',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown exam types', () => {
    expect(
      ProblemSourceSchema.safeParse({ exam_type: 'final_boss' }).success
    ).toBe(false);
  });
});

describe('CreateProblemDto (shell model)', () => {
  it('requires parts and defaults source/is_optional', () => {
    const parsed = CreateProblemDto.safeParse({
      subject_id: '2c8f3b1a-1111-4222-8333-444455556666',
      title: '生物大题',
      parts: [{ index: 1, type: 'essay', full_marks: 12 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toEqual({});
      expect(parsed.data.is_optional).toBe(false);
    }
  });

  it('rejects the legacy flat fields', () => {
    const parsed = CreateProblemDto.safeParse({
      subject_id: '2c8f3b1a-1111-4222-8333-444455556666',
      title: 'legacy',
      problem_type: 'mcq',
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Marking engine
// ---------------------------------------------------------------------------

const multiConfig: MultiMCQAnswerConfig = {
  type: 'multi_mcq',
  choices,
  correct_choice_ids: ['A', 'B', 'D'],
};

describe('multiChoiceCreditRatio (gaokao partial credit)', () => {
  it('full marks for the exact set', () => {
    expect(multiChoiceCreditRatio(['A', 'B', 'D'], multiConfig)).toBe(1);
  });

  it('partial credit for a non-empty strict subset', () => {
    expect(multiChoiceCreditRatio(['A', 'D'], multiConfig)).toBe(0.5);
  });

  it('zero as soon as a wrong choice is picked', () => {
    expect(multiChoiceCreditRatio(['A', 'C'], multiConfig)).toBe(0);
  });

  it('zero for an empty selection', () => {
    expect(multiChoiceCreditRatio([], multiConfig)).toBe(0);
  });

  it('honours a custom partial credit ratio', () => {
    expect(
      multiChoiceCreditRatio(['B'], {
        ...multiConfig,
        partial_credit_ratio: 0.4,
      })
    ).toBe(0.4);
  });
});

describe('markPart', () => {
  it('marks single choice via config', () => {
    const part: ProblemPart = {
      index: 1,
      type: 'single_choice',
      answer_config: { type: 'mcq', choices, correct_choice_id: 'C' },
    };
    expect(markPart(part, 'C')).toBe(true);
    expect(markPart(part, 'A')).toBe(false);
  });

  it('falls back to exact-match correct_answer for fill_blank', () => {
    const part: ProblemPart = {
      index: 1,
      type: 'fill_blank',
      correct_answer: '线粒体',
    };
    expect(markPart(part, ' 线粒体 ')).toBe(true);
    expect(markPart(part, '叶绿体')).toBe(false);
  });

  it('never auto-marks an essay via correct_answer', () => {
    const part: ProblemPart = {
      index: 1,
      type: 'essay',
      correct_answer: '范文',
    };
    expect(markPart(part, '范文')).toBeNull();
  });

  it('treats unknown config shapes as non-markable but keeps the fallback', () => {
    const part = {
      index: 1,
      type: 'short_answer',
      correct_answer: 'word',
      answer_config: { type: 'word_mistake' } as never,
    } as ProblemPart;
    expect(markPart(part, 'word')).toBe(true);
  });

  it('returns null for unanswered parts', () => {
    const part: ProblemPart = {
      index: 1,
      type: 'fill_blank',
      correct_answer: 'x',
    };
    expect(markPart(part, undefined)).toBeNull();
  });
});

describe('markProblem (whole shell)', () => {
  const shell: ProblemPart[] = [
    {
      index: 1,
      type: 'single_choice',
      full_marks: 2,
      answer_config: { type: 'mcq', choices, correct_choice_id: 'B' },
    },
    {
      index: 2,
      type: 'multi_choice',
      full_marks: 6,
      answer_config: multiConfig,
    },
    { index: 3, type: 'fill_blank', full_marks: 4, correct_answer: '42' },
    { index: 4, type: 'short_answer', full_marks: 8 },
  ];

  it('scores per part and rolls up totals (multi-blank/multi-part)', () => {
    const result = markProblem(
      shell,
      new Map<number, unknown>([
        [1, 'B'],
        [2, ['A', 'B']], // subset -> half credit
        [3, '41'],
        [4, '略'],
      ])
    );
    expect(result.part_results).toEqual([
      { index: 1, correct: true, score: 2 },
      { index: 2, correct: false, score: 3 },
      { index: 3, correct: false, score: 0 },
      { index: 4, correct: null },
    ]);
    expect(result.total_score).toBe(5);
    expect(result.total_full_marks).toBe(20);
    expect(result.all_correct).toBe(false);
    expect(result.auto_marked).toBe(true);
  });

  it('all_correct requires every part marked and correct', () => {
    const objectiveOnly = shell.slice(0, 3);
    const result = markProblem(
      objectiveOnly,
      new Map<number, unknown>([
        [1, 'B'],
        [2, ['A', 'B', 'D']],
        [3, '42'],
      ])
    );
    expect(result.all_correct).toBe(true);
    expect(result.total_score).toBe(12);
  });

  it('reports auto_marked=false for a purely subjective shell', () => {
    const result = markProblem(
      [{ index: 1, type: 'essay', full_marks: 60 }],
      new Map<number, unknown>([[1, '作文']])
    );
    expect(result.auto_marked).toBe(false);
    expect(result.all_correct).toBe(false);
    expect(result.part_results).toEqual([{ index: 1, correct: null }]);
  });
});

describe('auto-markability helpers', () => {
  it('derives from config or bare correct_answer', () => {
    expect(
      isPartAutoMarkable({ index: 1, type: 'fill_blank', correct_answer: 'x' })
    ).toBe(true);
    expect(isPartAutoMarkable({ index: 1, type: 'short_answer' })).toBe(false);
    expect(
      isPartAutoMarkable({ index: 1, type: 'essay', correct_answer: '范文' })
    ).toBe(false);
    expect(
      problemHasAutoMark([
        { index: 1, type: 'essay' },
        { index: 2, type: 'fill_blank', correct_answer: 'y' },
      ])
    ).toBe(true);
  });
});
