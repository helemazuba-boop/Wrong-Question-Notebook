import { ANSWER_CONFIG_CONSTANTS } from './constants';
import type {
  AnswerConfig,
  MCQAnswerConfig,
  MultiMCQAnswerConfig,
  ShortAnswerTextConfig,
  ShortAnswerNumericConfig,
  ProblemPart,
  PartResult,
} from './types';

/**
 * Shell-model marking. A problem is a shell of 1..10 typed parts; each part
 * is marked independently and the attempt rolls the results up.
 *
 * Auto-markability is derived, not declared: a part with an answer_config
 * whose shape we understand (or a bare legacy correct_answer) gets a verdict;
 * anything else (short_answer/essay without config, unknown config types such
 * as the word_mistake projection metadata) stays `correct: null` for
 * self-assessment.
 */

export interface MarkProblemResult {
  part_results: PartResult[];
  /** True when every auto-markable part is correct AND none is pending. */
  all_correct: boolean;
  /** True when at least one part could be auto-marked. */
  auto_marked: boolean;
  /** Sum of part scores; null when no part declares full_marks. */
  total_score: number | null;
  /** Sum of declared full_marks; null when no part declares any. */
  total_full_marks: number | null;
}

/** True when the part carries a usable answer key. */
export function isPartAutoMarkable(part: ProblemPart): boolean {
  const config = part.answer_config;
  if (
    config &&
    (config.type === 'mcq' ||
      config.type === 'multi_mcq' ||
      config.type === 'short')
  ) {
    return true;
  }
  return !!part.correct_answer && part.type !== 'essay';
}

/** True when at least one part of the shell can be auto-marked. */
export function problemHasAutoMark(parts: ProblemPart[]): boolean {
  return parts.some(isPartAutoMarkable);
}

/** Marks a single part. Returns null when the part cannot be auto-marked. */
export function markPart(
  part: ProblemPart,
  submittedAnswer: unknown
): boolean | null {
  if (submittedAnswer === undefined || submittedAnswer === null) {
    return null;
  }
  const config = part.answer_config;
  if (config) {
    const verdict = markWithConfig(submittedAnswer, config);
    if (verdict !== null) return verdict;
  }
  // Legacy fallback: exact case-insensitive match on correct_answer. Essay
  // parts are never auto-marked this way (a written response matching the
  // model answer verbatim is meaningless).
  if (part.correct_answer && part.type !== 'essay') {
    return (
      String(submittedAnswer).trim().toLowerCase() ===
      part.correct_answer.trim().toLowerCase()
    );
  }
  return null;
}

/**
 * Gaokao multi-choice partial credit as a fraction of full marks: exact match
 * = 1, non-empty strict subset of the correct set = partial ratio, any wrong
 * pick (or empty selection) = 0.
 */
export function multiChoiceCreditRatio(
  submitted: string[],
  config: MultiMCQAnswerConfig
): number {
  const picked = new Set(submitted.map(choice => String(choice).trim()));
  if (picked.size === 0) return 0;
  const correct = new Set(config.correct_choice_ids);
  for (const choice of picked) {
    if (!correct.has(choice)) return 0;
  }
  if (picked.size === correct.size) return 1;
  return (
    config.partial_credit_ratio ??
    ANSWER_CONFIG_CONSTANTS.MULTI_MCQ.DEFAULT_PARTIAL_CREDIT_RATIO
  );
}

/**
 * Marks a whole shell. `answers` maps part index -> submitted answer (missing
 * entries are treated as unanswered / self-assessed pending).
 */
export function markProblem(
  parts: ProblemPart[],
  answers: ReadonlyMap<number, unknown>
): MarkProblemResult {
  const partResults: PartResult[] = [];
  let autoMarked = false;
  let allCorrect = true;
  let totalScore: number | null = null;
  let totalFullMarks: number | null = null;

  for (const part of parts) {
    const submitted = answers.get(part.index);
    const correct = markPart(part, submitted);
    const result: PartResult = { index: part.index, correct };

    if (part.full_marks !== undefined) {
      totalFullMarks = (totalFullMarks ?? 0) + part.full_marks;
    }
    if (correct === null) {
      // Pending self-assessment: the shell cannot be called fully correct.
      allCorrect = false;
    } else {
      autoMarked = true;
      let ratio: number = correct ? 1 : 0;
      // Partial credit only exists for multi-choice; every other markable
      // part is all-or-nothing.
      if (
        part.answer_config?.type === 'multi_mcq' &&
        Array.isArray(submitted)
      ) {
        ratio = multiChoiceCreditRatio(
          submitted.map(String),
          part.answer_config
        );
      }
      if (!correct) allCorrect = false;
      if (part.full_marks !== undefined) {
        result.score = roundScore(part.full_marks * ratio);
        totalScore = (totalScore ?? 0) + result.score;
      }
    }
    partResults.push(result);
  }

  return {
    part_results: partResults,
    all_correct: autoMarked && allCorrect,
    auto_marked: autoMarked,
    total_score: totalScore,
    total_full_marks: totalFullMarks,
  };
}

function markWithConfig(
  submittedAnswer: unknown,
  config: AnswerConfig
): boolean | null {
  switch (config.type) {
    case 'mcq':
      return markMCQ(submittedAnswer, config);
    case 'multi_mcq':
      return markMultiMCQ(submittedAnswer, config);
    case 'short':
      if (config.mode === 'text') {
        return markShortText(submittedAnswer, config);
      }
      if (config.mode === 'numeric') {
        return markShortNumeric(submittedAnswer, config);
      }
      return null;
    default:
      // Unknown config shapes (e.g. word_mistake projection metadata) are
      // not markable.
      return null;
  }
}

function markMCQ(submittedAnswer: unknown, config: MCQAnswerConfig): boolean {
  return String(submittedAnswer).trim() === config.correct_choice_id;
}

function markMultiMCQ(
  submittedAnswer: unknown,
  config: MultiMCQAnswerConfig
): boolean | null {
  if (!Array.isArray(submittedAnswer)) return null;
  // "Correct" means the exact set; partial credit is a score concern, not a
  // correctness one.
  return multiChoiceCreditRatio(submittedAnswer.map(String), config) === 1;
}

function markShortText(
  submittedAnswer: unknown,
  config: ShortAnswerTextConfig
): boolean {
  const submitted = String(submittedAnswer).trim().toLowerCase();
  return config.acceptable_answers.some(
    answer => answer.trim().toLowerCase() === submitted
  );
}

function markShortNumeric(
  submittedAnswer: unknown,
  config: ShortAnswerNumericConfig
): boolean {
  const submitted =
    typeof submittedAnswer === 'number'
      ? submittedAnswer
      : parseFloat(String(submittedAnswer).trim());

  if (isNaN(submitted)) return false;

  const { correct_value, tolerance } = config.numeric_config;
  return Math.abs(submitted - correct_value) <= tolerance;
}

/** Half-mark precision covers every gaokao partial-credit scheme. */
function roundScore(score: number): number {
  return Math.round(score * 2) / 2;
}
