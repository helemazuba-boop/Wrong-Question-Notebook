import { describe, it, expect } from 'vitest';
import { buildPrintSheet } from '../print-sheet-model';
import type { Problem, ProblemPart } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function part(
  overrides: Partial<ProblemPart> & { index: number }
): ProblemPart {
  return { type: 'short_answer', ...overrides };
}

function problem(overrides: Partial<Problem> & { id: string }): Problem {
  return {
    title: '题目',
    content: '<p>题干</p>',
    parts: [],
    status: 'wrong',
    subject_id: 'subject-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * A stored config shape the `AnswerConfig` union does not cover. Unknown
 * shapes really do ride in that slot — `StoredProblemPartsSchema` types it as
 * `Record<string, unknown>` for exactly this reason — so the model has to
 * survive them.
 */
const UNKNOWN_SHAPED_CONFIG = {
  type: 'word_mistake',
  stable_key: 'wm.derivative-sign',
} as unknown as Problem['answer_config'];

const CHOICES = [
  { id: 'A', text: '1' },
  { id: 'B', text: '-1' },
  { id: 'C', text: '0' },
];

// ---------------------------------------------------------------------------
// Answer extraction
// ---------------------------------------------------------------------------

describe('answer extraction', () => {
  it('keeps a single-choice answer as its option id', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'single_choice',
              answer_config: {
                type: 'mcq',
                choices: CHOICES,
                correct_choice_id: 'C',
                randomize_choices: true,
              },
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'choice',
      optionIds: ['C'],
    });
  });

  it('sorts a multi-choice answer into option order', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'multi_choice',
              answer_config: {
                type: 'multi_mcq',
                choices: CHOICES,
                correct_choice_ids: ['C', 'A'],
              },
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'choice',
      optionIds: ['A', 'C'],
    });
  });

  it('carries every acceptable answer, not just the first', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'short_answer',
              answer_config: {
                type: 'short',
                mode: 'text',
                acceptable_answers: ['0', '零', '０'],
              },
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'text',
      values: ['0', '零', '０'],
    });
  });

  it('carries a numeric answer with its tolerance and unit', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'short_answer',
              answer_config: {
                type: 'short',
                mode: 'numeric',
                numeric_config: {
                  correct_value: 9.8,
                  tolerance: 0.1,
                  unit: 'm/s²',
                },
              },
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '物理' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'numeric',
      value: 9.8,
      tolerance: 0.1,
      unit: 'm/s²',
    });
  });

  it('defaults a numeric answer with no unit and no usable tolerance', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              answer_config: {
                type: 'short',
                mode: 'numeric',
                // A row written before the tolerance field existed.
                numeric_config: { correct_value: 42 },
              } as never,
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'numeric',
      value: 42,
      tolerance: 0,
      unit: null,
    });
  });

  it('falls back to correct_answer when a numeric config is unusable', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              correct_answer: '见解析',
              answer_config: {
                type: 'short',
                mode: 'numeric',
                numeric_config: { correct_value: 'NaN-ish' },
              } as never,
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'text',
      values: ['见解析'],
    });
  });

  it('treats an essay correct_answer as the reference answer', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({ index: 1, type: 'essay', correct_answer: '分类讨论' }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'text',
      values: ['分类讨论'],
    });
  });

  it('prints nothing for a part that carries no answer', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', parts: [part({ index: 1 })] })],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toBeNull();
    expect(sheet.problems[0].parts[0].inlineAnswer).toBeNull();
    expect(sheet.problems[0].hasKeyAnswers).toBe(false);
  });

  it('falls back to correct_answer for an unrecognised config shape', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              correct_answer: 'B',
              answer_config: UNKNOWN_SHAPED_CONFIG,
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'text',
      values: ['B'],
    });
  });

  it('prints nothing for a config it cannot read and no fallback', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            { index: 1, type: 'essay', answer_config: UNKNOWN_SHAPED_CONFIG },
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toBeNull();
  });

  it('still reads an answer when correct_answer has surrounding space', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [part({ index: 1, correct_answer: '  A  ' })],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'text',
      values: ['A'],
    });
  });
});

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

describe('choices', () => {
  it('emits stored order even when the screen would shuffle', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'single_choice',
              answer_config: {
                type: 'mcq',
                choices: CHOICES,
                correct_choice_id: 'A',
                randomize_choices: true,
              },
            }),
          ],
        }),
      ],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].choices).toEqual(CHOICES);
  });

  it('keeps every option letter present, so the key can point at them', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'single_choice',
              answer_config: {
                type: 'mcq',
                choices: CHOICES,
                correct_choice_id: 'B',
              },
            }),
          ],
        }),
      ],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].choices?.map(c => c.id)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('omits an option with a blank id but keeps the rest', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              answer_config: {
                type: 'mcq',
                choices: [{ id: '', text: 'broken' }, ...CHOICES],
                correct_choice_id: 'A',
              } as never,
            }),
          ],
        }),
      ],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].choices).toEqual(CHOICES);
  });

  it('has no choices for a written part', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', parts: [part({ index: 1, type: 'essay' })] })],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].choices).toBeNull();
  });

  it('has no choices when the choice list is absent from a choice config', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              answer_config: { type: 'mcq', correct_choice_id: 'A' } as never,
            }),
          ],
        }),
      ],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].choices).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Writing lines and part labels
// ---------------------------------------------------------------------------

describe('writing lines and labels', () => {
  it('gives a written part a line in every placement', () => {
    const parts = [part({ index: 1, type: 'short_answer' })];
    for (const placement of ['end', 'below', 'none'] as const) {
      const sheet = buildPrintSheet([problem({ id: 'p1', parts })], {
        placement,
        subjectName: '数学',
      });
      expect(sheet.problems[0].parts[0].writingLines).toBe(1);
    }
  });

  it('gives an essay room to write, not a single line', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', parts: [part({ index: 1, type: 'essay' })] })],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].writingLines).toBe(4);
  });

  it('gives a choice part no line — the options are the answer area', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({
              index: 1,
              type: 'single_choice',
              answer_config: {
                type: 'mcq',
                choices: CHOICES,
                correct_choice_id: 'A',
              },
            }),
          ],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].writingLines).toBe(0);
  });

  it('labels multi-part problems and leaves a single part unlabelled', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [
            part({ index: 1, label: '(1)' }),
            part({ index: 2 }),
            part({ index: 3, label: '' }),
          ],
        }),
        problem({ id: 'p2', parts: [part({ index: 1, label: '(1)' })] }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts.map(p => p.label)).toEqual([
      '(1)',
      '(2)',
      '(3)',
    ]);
    expect(sheet.problems[1].parts[0].label).toBeNull();
  });

  it('carries full marks when the part declares them', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts: [part({ index: 1, full_marks: 12 }), part({ index: 2 })],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts.map(p => p.fullMarks)).toEqual([12, null]);
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('placement', () => {
  const parts = [
    part({
      index: 1,
      answer_config: {
        type: 'mcq',
        choices: CHOICES,
        correct_choice_id: 'B',
      },
    }),
  ];
  const rows = [
    problem({ id: 'p1', title: '第一题', parts, solution_text: '<p>思路</p>' }),
  ];

  it("puts every answer on the key page under 'end'", () => {
    const sheet = buildPrintSheet(rows, {
      placement: 'end',
      subjectName: '数学',
    });

    expect(sheet.problems[0].parts[0].inlineAnswer).toBeNull();
    expect(sheet.problems[0].parts[0].keyAnswer).toEqual({
      kind: 'choice',
      optionIds: ['B'],
    });
    expect(sheet.problems[0].hasKeyAnswers).toBe(true);
    expect(sheet.keyProblemCount).toBe(1);
  });

  it("prints the answer under the part under 'below'", () => {
    const sheet = buildPrintSheet(rows, {
      placement: 'below',
      subjectName: '数学',
    });

    expect(sheet.problems[0].parts[0].inlineAnswer).toEqual({
      kind: 'choice',
      optionIds: ['B'],
    });
    expect(sheet.problems[0].parts[0].keyAnswer).toBeNull();
    expect(sheet.problems[0].hasKeyAnswers).toBe(false);
    expect(sheet.keyProblemCount).toBe(0);
  });

  it("carries the solution in both 'end' and 'below'", () => {
    for (const placement of ['end', 'below'] as const) {
      const sheet = buildPrintSheet(rows, { placement, subjectName: '数学' });
      expect(sheet.problems[0].solutionHtml).toBe('<p>思路</p>');
    }
  });

  it("carries no answer and no solution at all under 'none'", () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          parts,
          solution_text: '<p>思路</p>',
          solution_assets: [{ path: 'a.png' }],
        }),
      ],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].inlineAnswer).toBeNull();
    expect(sheet.problems[0].parts[0].keyAnswer).toBeNull();
    expect(sheet.problems[0].hasKeyAnswers).toBe(false);
    expect(sheet.problems[0].solutionHtml).toBeNull();
    expect(sheet.problems[0].solutionAssets).toEqual([]);
    expect(sheet.keyProblemCount).toBe(0);
  });

  it('still leaves the writing space under a practice-only sheet', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', parts: [part({ index: 1, type: 'essay' })] })],
      { placement: 'none', subjectName: '数学' }
    );

    expect(sheet.problems[0].parts[0].writingLines).toBeGreaterThan(0);
  });

  it('counts only the problems that contribute to the key page', () => {
    const sheet = buildPrintSheet(
      [
        problem({ id: 'p1', parts }),
        problem({ id: 'p2', parts: [part({ index: 1, type: 'essay' })] }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.keyProblemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sheet assembly
// ---------------------------------------------------------------------------

describe('sheet assembly', () => {
  it('renumbers the printed subset from the first number', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1' }), problem({ id: 'p2' }), problem({ id: 'p3' })],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems.map(p => [p.id, p.number])).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
    ]);
  });

  it('honours a non-default start number', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p5' }), problem({ id: 'p6' })],
      {
        placement: 'end',
        subjectName: '数学',
        startNumber: 5,
      }
    );

    expect(sheet.problems.map(p => p.number)).toEqual([5, 6]);
  });

  it('carries the subject name and the placement it was built with', () => {
    const sheet = buildPrintSheet([problem({ id: 'p1' })], {
      placement: 'below',
      subjectName: '英语',
    });

    expect(sheet.subjectName).toBe('英语');
    expect(sheet.placement).toBe('below');
  });

  it('keeps the title and the problem stem', () => {
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', title: '函数单调性', content: '<p>已知 f(x)</p>' })],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].title).toBe('函数单调性');
    expect(sheet.problems[0].contentHtml).toBe('<p>已知 f(x)</p>');
  });

  it('treats a blank stem as absent rather than an empty paragraph', () => {
    const sheet = buildPrintSheet([problem({ id: 'p1', content: '   ' })], {
      placement: 'end',
      subjectName: '数学',
    });

    expect(sheet.problems[0].contentHtml).toBeNull();
  });

  it('passes the solution assets through', () => {
    const assets = [{ path: 'sol-1.png', kind: 'image' as const }];
    const sheet = buildPrintSheet(
      [problem({ id: 'p1', solution_assets: assets })],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].solutionAssets).toEqual(assets);
  });

  it('survives a problem whose parts did not parse', () => {
    const broken = problem({ id: 'p1' });
    (broken as { parts: unknown }).parts = 'not-an-array';

    const sheet = buildPrintSheet([broken], {
      placement: 'end',
      subjectName: '数学',
    });

    expect(sheet.problems[0].parts).toEqual([]);
    expect(sheet.problems[0].hasKeyAnswers).toBe(false);
  });

  it('builds an empty sheet for no problems', () => {
    const sheet = buildPrintSheet([], {
      placement: 'end',
      subjectName: '数学',
    });

    expect(sheet.problems).toEqual([]);
    expect(sheet.keyProblemCount).toBe(0);
  });

  it('never turns owner-private context into a printable answer', () => {
    const sheet = buildPrintSheet(
      [
        problem({
          id: 'p1',
          // The one field a shared-set viewer must never see on paper.
          initial_idea: '我总是看错符号',
          tags: [{ id: 't1', name: '易错' }],
          parts: [part({ index: 1, type: 'essay' })],
        }),
      ],
      { placement: 'end', subjectName: '数学' }
    );

    expect(sheet.problems[0].hasKeyAnswers).toBe(false);
    expect(sheet.problems[0].parts[0].keyAnswer).toBeNull();
  });
});
