/**
 * Problem-form domain model: shell-model part drafts.
 *
 * Pure functions only — no React, no i18n, no fetch. The form component
 * owns draft state and translates validation issues into localized toasts;
 * this module owns the draft shape and the single source of truth for
 * whether a draft is submittable.
 *
 * Every part is edited through the SAME card (type + label + marks + answer
 * area). Draft state for every editor kind coexists per part, so switching
 * a part's type back and forth never loses input.
 */

import type { ProblemType } from '@/lib/schemas';
import { ANSWER_CONFIG_CONSTANTS } from '@/lib/constants';
import type {
  MCQChoice,
  AnswerConfig,
  ProblemPart,
} from '@/lib/types';
import type { ShortAnswerConfigValue } from '@/components/ui/short-answer-config';

export interface PartDraft {
  type: ProblemType;
  /** Display label, e.g. "(1)"; auto-renumbered until the user touches it. */
  label: string;
  labelTouched: boolean;
  fullMarks: string;
  /** Simple text answer (choice fallback / fill-blank / short simple mode). */
  answerText: string;
  // Choice builder state
  choices: MCQChoice[];
  correctChoiceId: string;
  multiCorrectText: string;
  randomizeChoices: boolean;
  useChoicePicker: boolean;
  // Short-answer advanced state
  shortConfig: ShortAnswerConfigValue;
  useAdvancedShort: boolean;
}

/** Why a part draft cannot be submitted yet. */
export type PartDraftIssueKind =
  | 'correct_choice_required'
  | 'answer_required'
  | 'numeric_incomplete';

export interface PartDraftIssue {
  partIndex: number;
  kind: PartDraftIssueKind;
}

export function defaultDraftChoices(): MCQChoice[] {
  return ANSWER_CONFIG_CONSTANTS.MCQ.DEFAULT_CHOICES.map(id => ({
    id,
    text: '',
  }));
}

export function makePartDraft(
  position: number,
  type: ProblemType = 'short_answer'
): PartDraft {
  return {
    type,
    label: `(${position})`,
    labelTouched: false,
    fullMarks: '',
    answerText: '',
    choices: defaultDraftChoices(),
    correctChoiceId: '',
    multiCorrectText: '',
    randomizeChoices: true,
    useChoicePicker: true,
    shortConfig: { mode: 'text', acceptable_answers: [] },
    useAdvancedShort: false,
  };
}

export function draftFromPart(part: ProblemPart, position: number): PartDraft {
  const draft = makePartDraft(position, part.type);
  draft.label = part.label || `(${position})`;
  draft.labelTouched = !!part.label && part.label !== `(${position})`;
  draft.fullMarks =
    part.full_marks !== undefined ? String(part.full_marks) : '';
  draft.answerText = part.correct_answer || '';
  const config = part.answer_config;
  if (config?.type === 'mcq') {
    draft.choices = config.choices;
    draft.correctChoiceId = config.correct_choice_id;
    draft.randomizeChoices = config.randomize_choices ?? true;
  } else if (config?.type === 'multi_mcq') {
    draft.choices = config.choices;
    draft.multiCorrectText = config.correct_choice_ids.join('');
    draft.randomizeChoices = config.randomize_choices ?? true;
  } else if (config?.type === 'short') {
    draft.useAdvancedShort = true;
    draft.shortConfig =
      config.mode === 'text'
        ? { mode: 'text', acceptable_answers: config.acceptable_answers }
        : {
            mode: 'numeric',
            numeric_config: {
              correct_value: config.numeric_config.correct_value,
              tolerance: config.numeric_config.tolerance,
              unit: config.numeric_config.unit,
            },
          };
  } else if (
    (part.type === 'single_choice' || part.type === 'multi_choice') &&
    part.correct_answer
  ) {
    // A choice part answered by plain text keeps the picker off on edit.
    draft.useChoicePicker = false;
  }
  return draft;
}

/** Correct choice ids parsed from compact letters, limited to existing ids. */
export function multiIdsOf(draft: PartDraft): string[] {
  const available = new Set(draft.choices.map(choice => choice.id));
  return [
    ...new Set(
      draft.multiCorrectText
        .toUpperCase()
        .split('')
        .map(letter => letter.trim())
        .filter(letter => available.has(letter))
    ),
  ];
}

export function buildDraftAnswerConfig(draft: PartDraft): AnswerConfig | null {
  if (draft.type === 'single_choice' && draft.useChoicePicker) {
    if (!draft.correctChoiceId) return null;
    return {
      type: 'mcq',
      choices: draft.choices,
      correct_choice_id: draft.correctChoiceId,
      randomize_choices: draft.randomizeChoices,
    };
  }
  if (draft.type === 'multi_choice' && draft.useChoicePicker) {
    const ids = multiIdsOf(draft);
    if (ids.length === 0) return null;
    return {
      type: 'multi_mcq',
      choices: draft.choices,
      correct_choice_ids: ids,
      randomize_choices: draft.randomizeChoices,
    };
  }
  if (
    (draft.type === 'fill_blank' || draft.type === 'short_answer') &&
    draft.useAdvancedShort
  ) {
    if (draft.shortConfig.mode === 'text') {
      if (draft.shortConfig.acceptable_answers.length === 0) return null;
      return {
        type: 'short',
        mode: 'text',
        acceptable_answers: draft.shortConfig.acceptable_answers,
      };
    }
    const nc = draft.shortConfig.numeric_config;
    if (nc.correct_value === '' || nc.tolerance === '') return null;
    return {
      type: 'short',
      mode: 'numeric',
      numeric_config: {
        correct_value: Number(nc.correct_value),
        tolerance: Number(nc.tolerance),
        unit: nc.unit || undefined,
      },
    };
  }
  return null;
}

export function buildDraftAnswerText(draft: PartDraft): string {
  if (draft.type === 'single_choice') {
    return draft.useChoicePicker && draft.correctChoiceId
      ? draft.correctChoiceId
      : draft.answerText;
  }
  if (draft.type === 'multi_choice') {
    if (draft.useChoicePicker) return multiIdsOf(draft).join('');
    return draft.answerText;
  }
  if (draft.useAdvancedShort) {
    if (draft.shortConfig.mode === 'text') {
      return draft.shortConfig.acceptable_answers[0] || '';
    }
    if (draft.shortConfig.numeric_config.correct_value !== '') {
      return String(draft.shortConfig.numeric_config.correct_value);
    }
    return '';
  }
  return draft.answerText;
}

/** After insert/remove: renumber every label the user never touched. */
export function renumberDrafts(drafts: PartDraft[]): PartDraft[] {
  return drafts.map((draft, i) =>
    draft.labelTouched ? draft : { ...draft, label: `(${i + 1})` }
  );
}

/**
 * The single validation authority for part drafts. The form's submit loop,
 * MCQChoiceEditor hints, and ShortAnswerConfig constraints all describe the
 * same rules; this function is where they live.
 *
 * Returns issues in part order; an empty array means the drafts can be
 * serialized and submitted.
 */
export function validatePartDrafts(parts: PartDraft[]): PartDraftIssue[] {
  const issues: PartDraftIssue[] = [];
  for (let i = 0; i < parts.length; i++) {
    const draft = parts[i];
    if (draft.type === 'single_choice' && draft.useChoicePicker) {
      if (!draft.correctChoiceId) {
        issues.push({ partIndex: i, kind: 'correct_choice_required' });
        continue;
      }
    }
    if (draft.type === 'multi_choice' && draft.useChoicePicker) {
      if (multiIdsOf(draft).length === 0) {
        issues.push({ partIndex: i, kind: 'correct_choice_required' });
        continue;
      }
    }
    if (
      (draft.type === 'fill_blank' || draft.type === 'short_answer') &&
      draft.useAdvancedShort
    ) {
      if (
        draft.shortConfig.mode === 'text' &&
        draft.shortConfig.acceptable_answers.length === 0
      ) {
        issues.push({ partIndex: i, kind: 'answer_required' });
        continue;
      }
      if (draft.shortConfig.mode === 'numeric') {
        const nc = draft.shortConfig.numeric_config;
        if (nc.correct_value === '' || nc.tolerance === '') {
          issues.push({ partIndex: i, kind: 'numeric_incomplete' });
          continue;
        }
      }
    }
  }
  return issues;
}
