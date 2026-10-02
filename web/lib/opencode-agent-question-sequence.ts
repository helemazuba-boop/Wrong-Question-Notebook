/**
 * The device walks its option bar as a two-slot window over the whole list,
 * so the list itself is bounded by the contract (`questionData.options`
 * maxItems) and by the worst-case SSE frame. Eight options of 256 code points
 * each stay under the 16 KiB frame with room for the envelope.
 */
export const OPENCODE_QUESTION_OPTION_LIMIT = 8;
// Serialized-bytes safety budget for one field's projected options. A payload
// over this is treated as unanswerable (abort-only ask) rather than risking
// `frame_overflow` on the device.
export const OPENCODE_QUESTION_FRAME_BUDGET_BYTES = 10 * 1024;

/**
 * Cross-request state for a multi-field form.
 *
 * v2 settles a form on the FIRST reply, even a partial one, so the cloud
 * cannot answer field by field upstream. The relay (the SSE attach) projects
 * one field at a time and this store accumulates the device's answers between
 * separate HTTP requests; only the last step triggers the single upstream
 * reply. It is process-local on purpose: the state is short-lived, rebuildable
 * from the form detail, and the standalone deployment is a single Node
 * process. A restart mid-sequence re-asks from step 0 rather than losing the
 * ask.
 */

export interface OpenCodeSequenceOption {
  value: string;
  label: string;
}

export interface OpenCodeSequenceField {
  fieldKey: string;
  title: string;
  options: OpenCodeSequenceOption[];
  optionCount: number;
}

/** The form shape this store needs; the gateway's projection satisfies it. */
export interface OpenCodeSequenceForm {
  id: string;
  title: string;
  fields: OpenCodeSequenceField[];
}

export interface OpenCodeQuestionStep {
  /** Step index within the sequence (0-based). */
  index: number;
  fieldKey: string;
  title: string;
  options: OpenCodeSequenceOption[];
  optionCount: number;
  /** Wire id: `{formId}#{index}`; the device echoes it back verbatim. */
  questionId: string;
}

export interface OpenCodeQuestionSequence {
  sessionId: string;
  formId: string;
  /** Answerable fields in order; empty means "fallback ask only". */
  steps: OpenCodeSequenceField[];
  fallback: OpenCodeSequenceField | null;
  /** Next unanswered step index. */
  current: number;
  answers: Record<string, string>;
  updatedAt: number;
}

export type OpenCodeQuestionRecordResult =
  | { status: 'unknown' }
  | { status: 'stale' }
  | { status: 'invalid' }
  | { status: 'recorded' }
  | { status: 'final'; answers: Record<string, string> };

/** A pathological form must not become a chain of dozens of asks. */
const MAX_STEPS = 16;
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 64;

const sequences = new Map<string, OpenCodeQuestionSequence>();

function keyOf(sessionId: string, formId: string): string {
  return `${sessionId}\u0000${formId}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * The device can answer a field when it carries between one and eight options
 * and their serialized payload fits the frame budget. Everything else — text
 * fields, over-long lists, boolean/number fields — is projected only as a
 * fallback ask the user can abort.
 */
function isAnswerableField(field: OpenCodeSequenceField): boolean {
  if (field.options.length < 1) return false;
  if (field.options.length > OPENCODE_QUESTION_OPTION_LIMIT) return false;
  return (
    utf8Bytes(JSON.stringify(field.options)) <=
    OPENCODE_QUESTION_FRAME_BUDGET_BYTES
  );
}

function sweep(now: number): void {
  for (const [key, sequence] of sequences) {
    if (now - sequence.updatedAt > TTL_MS) sequences.delete(key);
  }
  if (sequences.size <= MAX_ENTRIES) return;
  const oldestFirst = [...sequences.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [key] of oldestFirst.slice(0, sequences.size - MAX_ENTRIES)) {
    sequences.delete(key);
  }
}

export function getQuestionSequence(
  sessionId: string,
  formId: string
): OpenCodeQuestionSequence | null {
  sweep(Date.now());
  return sequences.get(keyOf(sessionId, formId)) ?? null;
}

export function beginOrGetQuestionSequence(
  sessionId: string,
  form: OpenCodeSequenceForm
): OpenCodeQuestionSequence {
  sweep(Date.now());
  const key = keyOf(sessionId, form.id);
  const existing = sequences.get(key);
  if (existing) return existing;
  const answerable = form.fields.filter(isAnswerableField);
  // Too many steps is as unanswerable as none: the escape hatch is the ask.
  const steps = answerable.length > MAX_STEPS ? [] : answerable;
  const sequence: OpenCodeQuestionSequence = {
    sessionId,
    formId: form.id,
    steps,
    fallback: steps.length === 0 ? (form.fields[0] ?? null) : null,
    current: 0,
    answers: {},
    updatedAt: Date.now(),
  };
  sequences.set(key, sequence);
  return sequence;
}

/** The ask the device should currently be showing, or null when done. */
export function currentQuestionStep(
  sequence: OpenCodeQuestionSequence
): OpenCodeQuestionStep | null {
  if (sequence.steps.length === 0) {
    if (!sequence.fallback) return null;
    return {
      index: 0,
      fieldKey: sequence.fallback.fieldKey,
      title: sequence.fallback.title,
      options: [],
      optionCount: sequence.fallback.optionCount,
      questionId: `${sequence.formId}#0`,
    };
  }
  if (sequence.current >= sequence.steps.length) return null;
  const field = sequence.steps[sequence.current];
  return {
    index: sequence.current,
    fieldKey: field.fieldKey,
    title: field.title,
    options: field.options.slice(0, OPENCODE_QUESTION_OPTION_LIMIT),
    optionCount: field.optionCount,
    questionId: `${sequence.formId}#${sequence.current}`,
  };
}

export function recordQuestionAnswer(params: {
  sessionId: string;
  formId: string;
  step: number;
  answer: string;
}): OpenCodeQuestionRecordResult {
  const sequence = getQuestionSequence(params.sessionId, params.formId);
  if (!sequence) return { status: 'unknown' };
  if (sequence.steps.length === 0 || params.step < sequence.current) {
    return { status: 'stale' };
  }
  if (params.step > sequence.current) return { status: 'invalid' };
  const field = sequence.steps[sequence.current];
  sequence.answers[field.fieldKey] = params.answer;
  sequence.current += 1;
  sequence.updatedAt = Date.now();
  if (sequence.current >= sequence.steps.length) {
    return { status: 'final', answers: { ...sequence.answers } };
  }
  return { status: 'recorded' };
}

/** Undo the last recorded answer after an upstream submit failure. */
export function rollbackQuestionAnswer(
  sessionId: string,
  formId: string
): void {
  const sequence = getQuestionSequence(sessionId, formId);
  if (!sequence || sequence.current === 0 || sequence.steps.length === 0) {
    return;
  }
  sequence.current -= 1;
  const field = sequence.steps[sequence.current];
  delete sequence.answers[field.fieldKey];
  sequence.updatedAt = Date.now();
}

export function completeQuestionSequence(
  sessionId: string,
  formId: string
): void {
  sequences.delete(keyOf(sessionId, formId));
}

/** Drop every sequence of a session: the run ended or was interrupted. */
export function abandonQuestionSequences(sessionId: string): void {
  for (const [key, sequence] of sequences) {
    if (sequence.sessionId === sessionId) sequences.delete(key);
  }
}

export function __resetQuestionSequencesForTest(): void {
  sequences.clear();
}
