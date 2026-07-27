import { describe, it, expect } from 'vitest';
import {
  parsePastedExtraction,
  cleanHint,
  type ExtractedPart,
} from '../problem-extraction';

const validShell = {
  title: 'Projectile Motion With Two Parts',
  content: 'A ball is thrown with initial speed $v_0$ at angle $\\theta$.',
  parts: [
    {
      index: 1,
      label: '(1)',
      type: 'fill_blank',
      content: 'Find the time of flight.',
      full_marks: 4,
      answer_hint: {
        short_answer_value: '2.4',
        short_answer_is_numeric: true,
        answer_confidence: 'high',
      },
    },
    {
      index: 2,
      label: '(2)',
      type: 'essay',
      content: 'Derive the maximum height.',
      full_marks: 8,
      answer_hint: null,
    },
  ],
  suggest_image_asset: false,
  suggested_tags: { new_tag_names: ['kinematics', 'Kinematics', ''] },
  confidence: {
    problem_type_confidence: 'high',
    content_quality: 'clear',
    has_math: true,
  },
};

describe('parsePastedExtraction', () => {
  it('accepts a valid shell-model payload', () => {
    const result = parsePastedExtraction(JSON.stringify(validShell));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parts).toHaveLength(2);
    expect(result.data.parts[0].type).toBe('fill_blank');
    expect(result.data.parts[1].index).toBe(2);
    expect(result.data.title).toBe('Projectile Motion With Two Parts');
  });

  it('strips markdown code fences around the JSON', () => {
    const fenced = '```json\n' + JSON.stringify(validShell) + '\n```';
    const result = parsePastedExtraction(fenced);
    expect(result.ok).toBe(true);
  });

  it('dedupes tag names case-insensitively and drops empties', () => {
    const result = parsePastedExtraction(JSON.stringify(validShell));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.new_tag_names).toEqual(['kinematics']);
  });

  it('renumbers out-of-order part indices sequentially', () => {
    const shuffled = {
      ...validShell,
      parts: [
        { ...validShell.parts[1], index: 7 },
        { ...validShell.parts[0], index: 3 },
      ],
    };
    const result = parsePastedExtraction(JSON.stringify(shuffled));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parts.map(p => p.index)).toEqual([1, 2]);
    expect(result.data.parts[0].type).toBe('fill_blank');
  });

  it('converts a legacy single-part payload into a one-part shell', () => {
    const legacy = {
      problem_type: 'single_choice',
      title: 'Legacy MCQ',
      content: 'Which is prime?',
      mcq_choices: [
        { id: 'A', text: '$4$' },
        { id: 'B', text: '$5$' },
      ],
      answer_hint: {
        mcq_correct_choice_id: 'B',
        answer_confidence: 'high',
      },
      suggest_image_asset: false,
    };
    const result = parsePastedExtraction(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parts).toHaveLength(1);
    expect(result.data.parts[0].type).toBe('single_choice');
    expect(result.data.parts[0].answer_hint?.mcq_correct_choice_id).toBe('B');
    expect(result.data.content).toBe('');
  });

  it('rejects non-JSON input with invalid_json', () => {
    const result = parsePastedExtraction('this is not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_json');
  });

  it('rejects schema-invalid payloads with a path detail', () => {
    const bad = { ...validShell, parts: [] };
    const result = parsePastedExtraction(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_schema');
    expect(result.detail).toContain('parts');
  });

  it('rejects more than 10 parts', () => {
    const tooMany = {
      ...validShell,
      parts: Array.from({ length: 11 }, (_, i) => ({
        index: i + 1,
        type: 'short_answer',
        content: `part ${i + 1}`,
      })),
    };
    const result = parsePastedExtraction(JSON.stringify(tooMany));
    expect(result.ok).toBe(false);
  });
});

describe('cleanHint', () => {
  const base: ExtractedPart = {
    index: 1,
    label: null,
    type: 'single_choice',
    content: 'stem',
    full_marks: null,
    mcq_choices: [
      { id: 'A', text: 'a' },
      { id: 'B', text: 'b' },
    ],
    answer_hint: null,
  };

  it('drops low-confidence hints for non-essay parts', () => {
    expect(
      cleanHint({
        ...base,
        answer_hint: {
          mcq_correct_choice_id: 'A',
          answer_confidence: 'low',
        },
      })
    ).toBeNull();
  });

  it('nulls choice ids not present in the choices', () => {
    expect(
      cleanHint({
        ...base,
        answer_hint: {
          mcq_correct_choice_id: 'C',
          answer_confidence: 'high',
        },
      })
    ).toBeNull();
  });

  it('validates concatenated multi-choice ids', () => {
    const hint = cleanHint({
      ...base,
      type: 'multi_choice',
      answer_hint: {
        mcq_correct_choice_id: 'AB',
        answer_confidence: 'high',
      },
    });
    expect(hint?.mcq_correct_choice_id).toBe('AB');
  });

  it('zeroes out fields that mismatch the part type', () => {
    const hint = cleanHint({
      ...base,
      type: 'fill_blank',
      answer_hint: {
        mcq_correct_choice_id: 'A',
        short_answer_value: '42',
        short_answer_is_numeric: true,
        extended_working: 'should be dropped',
        answer_confidence: 'high',
      },
    });
    expect(hint?.mcq_correct_choice_id).toBeNull();
    expect(hint?.short_answer_value).toBe('42');
    expect(hint?.extended_working).toBeNull();
  });

  it('keeps essay working even at low confidence', () => {
    const hint = cleanHint({
      ...base,
      type: 'essay',
      answer_hint: {
        extended_working: '$$x=1$$',
        answer_confidence: 'low',
      },
    });
    expect(hint?.extended_working).toBe('$$x=1$$');
  });
});
