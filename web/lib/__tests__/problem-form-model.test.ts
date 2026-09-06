import { describe, expect, it } from 'vitest';

import {
  buildDraftAnswerConfig,
  buildDraftAnswerText,
  draftFromPart,
  makePartDraft,
  multiIdsOf,
  renumberDrafts,
  validatePartDrafts,
  type PartDraft,
} from '../problem-form/model';

describe('problem-form model', () => {
  describe('multiIdsOf', () => {
    it('parses compact letters to existing choice ids, deduped', () => {
      const draft = makePartDraft(1, 'multi_choice');
      draft.choices = [
        { id: 'A', text: '' },
        { id: 'B', text: '' },
        { id: 'C', text: '' },
      ];
      draft.multiCorrectText = 'aba';
      expect(multiIdsOf(draft)).toEqual(['A', 'B']);
    });

    it('drops letters without a matching choice', () => {
      const draft = makePartDraft(1, 'multi_choice');
      draft.choices = [{ id: 'A', text: '' }];
      draft.multiCorrectText = 'AD';
      expect(multiIdsOf(draft)).toEqual(['A']);
    });
  });

  describe('validatePartDrafts', () => {
    it('accepts a simple short-answer draft with no config', () => {
      expect(validatePartDrafts([makePartDraft(1)])).toEqual([]);
    });

    it('requires a correct choice on single-choice picker parts', () => {
      const draft = makePartDraft(1, 'single_choice');
      const issues = validatePartDrafts([draft]);
      expect(issues).toEqual([
        { partIndex: 0, kind: 'correct_choice_required' },
      ]);
    });

    it('passes single-choice parts once a correct choice is picked', () => {
      const draft = makePartDraft(1, 'single_choice');
      draft.correctChoiceId = 'B';
      expect(validatePartDrafts([draft])).toEqual([]);
    });

    it('requires at least one correct id on multi-choice picker parts', () => {
      const draft = makePartDraft(1, 'multi_choice');
      expect(validatePartDrafts([draft])).toEqual([
        { partIndex: 0, kind: 'correct_choice_required' },
      ]);
    });

    it('requires acceptable answers in advanced text mode', () => {
      const draft = makePartDraft(1, 'short_answer');
      draft.useAdvancedShort = true;
      draft.shortConfig = { mode: 'text', acceptable_answers: [] };
      expect(validatePartDrafts([draft])).toEqual([
        { partIndex: 0, kind: 'answer_required' },
      ]);
    });

    it('requires value and tolerance in numeric mode', () => {
      const draft = makePartDraft(1, 'fill_blank');
      draft.useAdvancedShort = true;
      draft.shortConfig = {
        mode: 'numeric',
        numeric_config: { correct_value: '', tolerance: '' },
      };
      expect(validatePartDrafts([draft])).toEqual([
        { partIndex: 0, kind: 'numeric_incomplete' },
      ]);
    });

    it('reports issues per part and keeps scanning parts', () => {
      const bad = makePartDraft(1, 'single_choice');
      const good = makePartDraft(2);
      const issues = validatePartDrafts([bad, good]);
      expect(issues).toEqual([
        { partIndex: 0, kind: 'correct_choice_required' },
      ]);
    });
  });

  describe('buildDraftAnswerConfig / buildDraftAnswerText', () => {
    it('builds an mcq config from the picker', () => {
      const draft = makePartDraft(1, 'single_choice');
      draft.choices = [
        { id: 'A', text: 'x' },
        { id: 'B', text: 'y' },
      ];
      draft.correctChoiceId = 'B';
      draft.randomizeChoices = false;
      expect(buildDraftAnswerConfig(draft)).toEqual({
        type: 'mcq',
        choices: draft.choices,
        correct_choice_id: 'B',
        randomize_choices: false,
      });
      expect(buildDraftAnswerText(draft)).toBe('B');
    });

    it('falls back to plain text when the picker is off', () => {
      const draft = makePartDraft(1, 'single_choice');
      draft.useChoicePicker = false;
      draft.answerText = 'BCD';
      expect(buildDraftAnswerConfig(draft)).toBeNull();
      expect(buildDraftAnswerText(draft)).toBe('BCD');
    });

    it('serializes numeric short config and mirrors the answer text', () => {
      const draft = makePartDraft(1, 'short_answer');
      draft.useAdvancedShort = true;
      draft.shortConfig = {
        mode: 'numeric',
        numeric_config: { correct_value: '3.5', tolerance: '0.1', unit: 'm' },
      };
      expect(buildDraftAnswerConfig(draft)).toEqual({
        type: 'short',
        mode: 'numeric',
        numeric_config: { correct_value: 3.5, tolerance: 0.1, unit: 'm' },
      });
      expect(buildDraftAnswerText(draft)).toBe('3.5');
    });
  });

  describe('renumberDrafts', () => {
    it('renumbers untouched labels only', () => {
      const a = makePartDraft(1);
      const b = makePartDraft(2);
      b.label = '(custom)';
      b.labelTouched = true;
      const c = makePartDraft(3);
      const renumbered = renumberDrafts([a, b, c]);
      expect(renumbered.map(d => d.label)).toEqual(['(1)', '(custom)', '(3)']);
    });
  });

  describe('draftFromPart round-trip', () => {
    it('restores mcq config state', () => {
      const source: ProblemPartFixture = {
        type: 'single_choice',
        correct_answer: 'A',
        answer_config: {
          type: 'mcq',
          choices: [
            { id: 'A', text: 'x' },
            { id: 'B', text: 'y' },
          ],
          correct_choice_id: 'A',
          randomize_choices: false,
        },
      };
      const draft = draftFromPart(source, 1);
      expect(draft.type).toBe('single_choice');
      expect(draft.correctChoiceId).toBe('A');
      expect(draft.randomizeChoices).toBe(false);
      expect(validatePartDrafts([draft])).toEqual([]);
    });

    it('keeps the picker off for a choice part answered by plain text', () => {
      const source: ProblemPartFixture = {
        type: 'multi_choice',
        correct_answer: 'AC',
      };
      const draft = draftFromPart(source, 1);
      expect(draft.useChoicePicker).toBe(false);
      expect(draft.answerText).toBe('AC');
    });
  });
});

type ProblemPartFixture = {
  type: PartDraft['type'];
  correct_answer?: string;
  answer_config?:
    | {
        type: 'mcq';
        choices: { id: string; text: string }[];
        correct_choice_id: string;
        randomize_choices?: boolean;
      }
    | {
        type: 'multi_mcq';
        choices: { id: string; text: string }[];
        correct_choice_ids: string[];
        randomize_choices?: boolean;
      };
};
