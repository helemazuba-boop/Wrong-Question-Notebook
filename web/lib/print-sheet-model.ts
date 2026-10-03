/**
 * Print worksheet model.
 *
 * Turns stored problems into the data a printed worksheet needs. A worksheet is
 * a *document*, not a state of the live review page: everything that decides
 * what reaches paper lives here, so the rendering component stays dumb and the
 * layout can be verified without a DOM.
 *
 * Three invariants to know before editing:
 *
 * 1. `parts` is JSONB, so `answer_config` is not guaranteed to be a
 *    well-formed `AnswerConfig` as read back — `StoredProblemPartsSchema` types
 *    it as `Record<string, unknown>` precisely because unknown shapes (such as
 *    word_mistake projection metadata) ride in that slot. Every read below
 *    narrows on the raw value and falls back to the part's bare
 *    `correct_answer`, so a malformed row prints a degraded sheet rather than
 *    throwing.
 *
 * 2. Choices are emitted in *stored* order, never shuffled and never with the
 *    letters hidden. The review screen shuffles them so a student cannot
 *    memorise positions; an answer key that says "A" has to point at the same
 *    "A" on the sheet, so the print path opts out of both behaviours.
 *
 * 3. Placement gates what the model carries at all. Under `none` the sheet
 *    holds no answers, no key entries and no solution text, so a bug in the
 *    rendering layer cannot leak them — the data is simply not there.
 *
 * Deliberately absent: `initial_idea` (owner-private context that shared-set
 * viewers must never see) and `tags` (metadata, not worksheet content). Both
 * are a line away if a worksheet ever needs them.
 */

import type { Asset, Problem, ProblemPart } from './types';

/**
 * Where the answers go on paper.
 *
 * - `end`   — answers and solutions collected on a final answer-key page
 * - `below` — each part's answer printed directly underneath it
 * - `none`  — bare practice sheet; nothing but writing space
 */
export type PrintAnswerPlacement = 'end' | 'below' | 'none';

/**
 * A part's answer in display form. Choice answers stay as option ids (the
 * student circles the letter); everything else is text, so it goes through the
 * math-aware text renderer the same way the on-screen reveal does.
 *
 * No answer is `null` rather than a variant of its own: a part with nothing to
 * reveal must print nothing, and one absent value means exactly that whether
 * the placement excludes it or the part never had a key.
 */
export type PrintAnswer =
  | { kind: 'choice'; optionIds: string[] }
  | { kind: 'text'; values: string[] }
  | {
      kind: 'numeric';
      value: number;
      tolerance: number;
      unit: string | null;
    };

/** One answer option of a choice part, in stored order. */
export interface PrintChoice {
  id: string;
  text: string;
}

export interface PrintPartBlock {
  index: number;
  /** Shell label for multi-part problems ("(1)"), null for a single-part one. */
  label: string | null;
  fullMarks: number | null;
  contentHtml: string | null;
  choices: PrintChoice[] | null;
  /**
   * How many ruled answer lines the student gets. A choice part is answered
   * by circling a letter, so it needs none; an essay needs room to write.
   */
  writingLines: number;
  /** Printed directly under the part. Only under `below`. */
  inlineAnswer: PrintAnswer | null;
  /** Contributes to the answer-key page. Only under `end`. */
  keyAnswer: PrintAnswer | null;
}

export interface PrintSheetProblem {
  id: string;
  /** 1-based position on the sheet, renumbered from the printed subset. */
  number: number;
  title: string;
  contentHtml: string | null;
  parts: PrintPartBlock[];
  /** True when any part contributes a key answer, i.e. the key page is worth printing. */
  hasKeyAnswers: boolean;
  solutionHtml: string | null;
  solutionAssets: Asset[];
}

export interface PrintSheet {
  placement: PrintAnswerPlacement;
  subjectName: string;
  problems: PrintSheetProblem[];
  /** Problems that actually contribute to the answer-key page. */
  keyProblemCount: number;
}

export interface BuildPrintSheetOptions {
  placement: PrintAnswerPlacement;
  subjectName: string;
  /** First number on the sheet. Defaults to 1. */
  startNumber?: number;
}

/** Ruled answer lines for a written part. */
const DEFAULT_WRITING_LINES = 1;
/** ...and for an essay, which a single line cannot hold. */
const ESSAY_WRITING_LINES = 4;

export function buildPrintSheet(
  problems: readonly Problem[],
  options: BuildPrintSheetOptions
): PrintSheet {
  const { placement, subjectName, startNumber = 1 } = options;

  const built: PrintSheetProblem[] = [];
  let number = startNumber;
  for (const problem of Array.isArray(problems) ? problems : []) {
    if (!problem) continue;
    built.push(buildProblem(problem, number, placement));
    number += 1;
  }

  return {
    placement,
    subjectName,
    problems: built,
    keyProblemCount: built.filter(problem => problem.hasKeyAnswers).length,
  };
}

function buildProblem(
  problem: Problem,
  number: number,
  placement: PrintAnswerPlacement
): PrintSheetProblem {
  const parts: ProblemPart[] = Array.isArray(problem.parts)
    ? problem.parts
    : [];
  const blocks = parts.map(part =>
    buildPart(part, placement, parts.length > 1)
  );
  const suppressAnswers = placement === 'none';

  return {
    id: problem.id,
    number,
    title: typeof problem.title === 'string' ? problem.title : '',
    contentHtml: htmlOrNull(problem.content),
    parts: blocks,
    hasKeyAnswers: blocks.some(block => block.keyAnswer !== null),
    solutionHtml: suppressAnswers ? null : htmlOrNull(problem.solution_text),
    solutionAssets: suppressAnswers
      ? []
      : Array.isArray(problem.solution_assets)
        ? problem.solution_assets
        : [],
  };
}

function buildPart(
  part: ProblemPart,
  placement: PrintAnswerPlacement,
  multiPart: boolean
): PrintPartBlock {
  const choices = choicesOf(part);
  const answer = answerOf(part);

  return {
    index: part.index,
    label: multiPart ? partLabelOf(part) : null,
    fullMarks: typeof part.full_marks === 'number' ? part.full_marks : null,
    contentHtml: htmlOrNull(part.content),
    choices,
    writingLines: writingLinesFor(part, choices),
    inlineAnswer: placement === 'below' ? answer : null,
    keyAnswer: placement === 'end' ? answer : null,
  };
}

/**
 * Answer space on paper. A choice part needs none — circling a letter is the
 * answer. Everything else gets one ruled line, and an essay gets a block,
 * because a single line could not hold a written response however the
 * placement is set: "pure practice" still needs somewhere to write.
 */
function writingLinesFor(
  part: ProblemPart,
  choices: PrintChoice[] | null
): number {
  if (choices !== null) return 0;
  return part.type === 'essay' ? ESSAY_WRITING_LINES : DEFAULT_WRITING_LINES;
}

/** "(1)" fallback matches the on-screen reveal, so the two never diverge. */
function partLabelOf(part: ProblemPart): string {
  const label = typeof part.label === 'string' ? part.label.trim() : '';
  return label.length > 0 ? label : `(${part.index})`;
}

function choicesOf(part: ProblemPart): PrintChoice[] | null {
  const config = configOf(part);
  if (!config) return null;
  const type = config.type;
  if (type !== 'mcq' && type !== 'multi_mcq') return null;
  if (!Array.isArray(config.choices)) return null;

  const choices: PrintChoice[] = [];
  for (const value of config.choices as unknown[]) {
    if (!isRecord(value)) continue;
    const { id, text } = value;
    if (typeof id !== 'string' || id.length === 0) continue;
    choices.push({ id, text: typeof text === 'string' ? text : '' });
  }

  // Stored order, never shuffled: see the module note.
  return choices.length > 0 ? choices : null;
}

function answerOf(part: ProblemPart): PrintAnswer | null {
  const config = configOf(part);

  if (config?.type === 'mcq') {
    const id = config.correct_choice_id;
    if (typeof id === 'string' && id.length > 0) {
      return { kind: 'choice', optionIds: [id] };
    }
  }

  if (
    config?.type === 'multi_mcq' &&
    Array.isArray(config.correct_choice_ids)
  ) {
    const ids = stringList(config.correct_choice_ids);
    if (ids.length > 0) {
      // The stored array is a set with no order of its own, and gaokao keys
      // are written in option order, so sort. Same collapse the device pack
      // uses, for the same reason.
      return { kind: 'choice', optionIds: [...ids].sort() };
    }
  }

  if (config?.type === 'short') {
    if (config.mode === 'text') {
      const values = stringList(config.acceptable_answers);
      if (values.length > 0) return { kind: 'text', values };
    }
    if (config.mode === 'numeric') {
      const numeric = numericAnswerOf(config.numeric_config);
      if (numeric) return numeric;
    }
  }

  // Legacy parts, and every essay: a bare text answer key.
  const legacy =
    typeof part.correct_answer === 'string' ? part.correct_answer.trim() : '';
  if (legacy.length > 0) return { kind: 'text', values: [legacy] };

  return null;
}

function numericAnswerOf(raw: unknown): PrintAnswer | null {
  if (!isRecord(raw)) return null;
  const { correct_value, tolerance, unit } = raw;
  if (typeof correct_value !== 'number' || !Number.isFinite(correct_value)) {
    return null;
  }
  return {
    kind: 'numeric',
    value: correct_value,
    tolerance:
      typeof tolerance === 'number' && Number.isFinite(tolerance)
        ? tolerance
        : 0,
    unit: typeof unit === 'string' && unit.length > 0 ? unit : null,
  };
}

/**
 * The part's answer_config as an untyped bag, or null when there is nothing
 * usable there. Callers narrow on `type` themselves rather than trusting the
 * `AnswerConfig` union, because the stored value may not satisfy it.
 */
function configOf(part: ProblemPart): Record<string, unknown> | null {
  const config: unknown = part.answer_config;
  if (!isRecord(config)) return null;
  return config;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string' && entry.length > 0) result.push(entry);
  }
  return result;
}

function htmlOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
