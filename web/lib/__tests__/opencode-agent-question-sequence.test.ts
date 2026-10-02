import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetQuestionSequencesForTest,
  abandonQuestionSequences,
  beginOrGetQuestionSequence,
  completeQuestionSequence,
  currentQuestionStep,
  getQuestionSequence,
  recordQuestionAnswer,
  rollbackQuestionAnswer,
  type OpenCodeSequenceField,
  type OpenCodeSequenceForm,
} from '@/lib/opencode-agent-question-sequence';

function field(
  fieldKey: string,
  options: string[],
  title = `${fieldKey} title`
): OpenCodeSequenceField {
  return {
    fieldKey,
    title,
    options: options.map(value => ({ value, label: value.toUpperCase() })),
    optionCount: options.length,
  };
}

function form(
  id: string,
  fields: OpenCodeSequenceField[]
): OpenCodeSequenceForm {
  return { id, title: 'Questions', fields };
}

const SESSION = 'ses_seq';

describe('OpenCode question sequence store', () => {
  beforeEach(() => {
    __resetQuestionSequencesForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns answerable fields into ordered steps and walks them', () => {
    const sequence = beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [
        field('fruit', ['apple', 'banana']),
        field('drink', ['water', 'tea']),
      ])
    );

    expect(sequence.steps.map(step => step.fieldKey)).toEqual([
      'fruit',
      'drink',
    ]);
    expect(sequence.fallback).toBeNull();

    expect(currentQuestionStep(sequence)).toMatchObject({
      index: 0,
      fieldKey: 'fruit',
      title: 'fruit title',
      questionId: 'frm_1#0',
      optionCount: 2,
    });

    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_1',
        step: 0,
        answer: 'apple',
      })
    ).toEqual({ status: 'recorded' });
    expect(currentQuestionStep(sequence)).toMatchObject({
      index: 1,
      fieldKey: 'drink',
      questionId: 'frm_1#1',
    });

    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_1',
        step: 1,
        answer: 'tea',
      })
    ).toEqual({
      status: 'final',
      answers: { fruit: 'apple', drink: 'tea' },
    });
    // Past the last step there is nothing left to show.
    expect(currentQuestionStep(sequence)).toBeNull();
  });

  it('reuses the existing sequence instead of rebuilding it', () => {
    const first = beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('fruit', ['apple'])])
    );
    recordQuestionAnswer({
      sessionId: SESSION,
      formId: 'frm_1',
      step: 0,
      answer: 'apple',
    });

    const second = beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('fruit', ['apple'])])
    );
    expect(second).toBe(first);
    // A rebuild from a later detail read must not restart the walk.
    expect(second.current).toBe(1);
  });

  it('skips unanswerable fields: empty, too many, or over the byte budget', () => {
    const tooMany = field(
      'many',
      Array.from({ length: 9 }, (_, index) => `o${index}`)
    );
    // Eight options at the schema maximum (256 astral code points for the
    // value, 80 for the label) serialize past the 10 KiB frame budget.
    const wide = field(
      'wide',
      Array.from({ length: 8 }, () => '😀'.repeat(256))
    );
    wide.options = wide.options.map(option => ({
      value: option.value,
      label: '😀'.repeat(80),
    }));

    const sequence = beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('note', []), tooMany, wide, field('pick', ['a'])])
    );

    expect(sequence.steps.map(step => step.fieldKey)).toEqual(['pick']);
  });

  it('falls back to the first field when nothing is answerable', () => {
    const sequence = beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('note', []), field('flag', [])])
    );

    expect(sequence.steps).toEqual([]);
    expect(sequence.fallback?.fieldKey).toBe('note');
    // The abort-only ask still carries a wire id and a visible title.
    expect(currentQuestionStep(sequence)).toMatchObject({
      index: 0,
      fieldKey: 'note',
      questionId: 'frm_1#0',
      options: [],
      optionCount: 0,
    });
  });

  it('refuses to walk a form with more than sixteen answerable fields', () => {
    const fields = Array.from({ length: 17 }, (_, index) =>
      field(`f${index}`, ['a'])
    );
    const sequence = beginOrGetQuestionSequence(SESSION, form('frm_1', fields));

    // Too many steps is as unanswerable as none: abort-only.
    expect(sequence.steps).toEqual([]);
    expect(sequence.fallback?.fieldKey).toBe('f0');
  });

  it('rejects out-of-order and duplicate answers', () => {
    beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('fruit', ['apple']), field('drink', ['tea'])])
    );

    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_1',
        step: 1,
        answer: 'tea',
      })
    ).toEqual({ status: 'invalid' });

    recordQuestionAnswer({
      sessionId: SESSION,
      formId: 'frm_1',
      step: 0,
      answer: 'apple',
    });
    // A duplicate of an already-recorded step is stale, not a rewrite.
    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_1',
        step: 0,
        answer: 'banana',
      })
    ).toEqual({ status: 'stale' });

    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_2',
        step: 0,
        answer: 'apple',
      })
    ).toEqual({ status: 'unknown' });
  });

  it('rolls back the last answer after a failed submit', () => {
    beginOrGetQuestionSequence(
      SESSION,
      form('frm_1', [field('fruit', ['apple']), field('drink', ['tea'])])
    );
    recordQuestionAnswer({
      sessionId: SESSION,
      formId: 'frm_1',
      step: 0,
      answer: 'apple',
    });
    recordQuestionAnswer({
      sessionId: SESSION,
      formId: 'frm_1',
      step: 1,
      answer: 'tea',
    });

    rollbackQuestionAnswer(SESSION, 'frm_1');
    const sequence = getQuestionSequence(SESSION, 'frm_1');
    expect(sequence?.current).toBe(1);
    expect(sequence?.answers).toEqual({ fruit: 'apple' });
    // The step is answerable again and the final submit re-sends both keys.
    expect(
      recordQuestionAnswer({
        sessionId: SESSION,
        formId: 'frm_1',
        step: 1,
        answer: 'water',
      })
    ).toEqual({
      status: 'final',
      answers: { fruit: 'apple', drink: 'water' },
    });

    // Nothing to undo once everything was consumed, and no sequence at all is
    // a silent no-op rather than a throw.
    rollbackQuestionAnswer(SESSION, 'frm_1');
    rollbackQuestionAnswer(SESSION, 'frm_missing');
    expect(getQuestionSequence(SESSION, 'frm_1')?.current).toBe(1);
  });

  it('drops a sequence on completion and every session sequence on abandon', () => {
    beginOrGetQuestionSequence(SESSION, form('frm_1', [field('a', ['x'])]));
    beginOrGetQuestionSequence(SESSION, form('frm_2', [field('b', ['y'])]));
    beginOrGetQuestionSequence('ses_other', form('frm_3', [field('c', ['z'])]));

    completeQuestionSequence(SESSION, 'frm_1');
    expect(getQuestionSequence(SESSION, 'frm_1')).toBeNull();
    expect(getQuestionSequence(SESSION, 'frm_2')).not.toBeNull();

    abandonQuestionSequences(SESSION);
    expect(getQuestionSequence(SESSION, 'frm_2')).toBeNull();
    expect(getQuestionSequence('ses_other', 'frm_3')).not.toBeNull();
  });

  it('expires a sequence after thirty minutes of silence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    beginOrGetQuestionSequence(SESSION, form('frm_1', [field('a', ['x'])]));

    vi.setSystemTime(new Date('2026-10-02T00:29:00Z'));
    expect(getQuestionSequence(SESSION, 'frm_1')).not.toBeNull();

    vi.setSystemTime(new Date('2026-10-02T00:31:00Z'));
    expect(getQuestionSequence(SESSION, 'frm_1')).toBeNull();
  });

  it('caps the store at sixty-four sequences, evicting the oldest', () => {
    vi.useFakeTimers();
    const base = new Date('2026-10-02T00:00:00Z').getTime();
    for (let index = 0; index < 65; index += 1) {
      vi.setSystemTime(new Date(base + index * 1000));
      beginOrGetQuestionSequence(
        SESSION,
        form(`frm_${index}`, [field('a', ['x'])])
      );
    }
    // The 65th insert is allowed; the next sweep trims back to the cap.
    vi.setSystemTime(new Date(base + 100_000));
    beginOrGetQuestionSequence(SESSION, form('frm_new', [field('a', ['x'])]));

    expect(getQuestionSequence(SESSION, 'frm_0')).toBeNull();
    expect(getQuestionSequence(SESSION, 'frm_new')).not.toBeNull();
  });
});
