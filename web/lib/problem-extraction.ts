import { z } from 'zod';
import { PROBLEM_TYPE_VALUES } from './schemas';
import { PROBLEM_CONSTANTS } from './constants';

// =====================================================
// Shell-model problem extraction contract
//
// Final-Problem draft adapter. Platform vision and new external prompts first
// produce Problem Ingestion v1; each selected ingestion question is then
// validated/normalised through this schema before it may become a Problem.
// The paste tab also keeps accepting this direct/legacy single-Problem shape.
// A problem is a shell (shared stem in `content`) plus 1..N typed parts,
// matching the gaokao shell model used by the problem form and storage.
// =====================================================

const AnswerConfidenceSchema = z.enum(['high', 'medium', 'low']);

// Callers hand in the compact pipeline form ("BC"), the separator forms
// external models naturally emit ("B,C", "B、C") and plain arrays
// (["B", "C"]). Normalise arrays here so every reader keeps seeing a string;
// cleanHint is what turns any of these into the canonical compact form.
const ChoiceIdInputSchema = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .transform(value => (Array.isArray(value) ? value.join('') : value));

export const ExtractedAnswerHintSchema = z.object({
  mcq_correct_choice_id: ChoiceIdInputSchema,
  short_answer_value: z.string().nullish(),
  short_answer_is_numeric: z.boolean().nullish(),
  extended_working: z.string().nullish(),
  answer_confidence: AnswerConfidenceSchema.default('medium'),
});

export const ExtractedMcqChoiceSchema = z.object({
  id: z.string().min(1).max(4),
  text: z.string(),
});

export const ExtractedPartSchema = z.object({
  index: z.number().int().min(1).max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  label: z.string().max(20).nullish(),
  type: z.enum(PROBLEM_TYPE_VALUES),
  content: z.string().default(''),
  full_marks: z.number().min(0).max(999).nullish(),
  mcq_choices: z.array(ExtractedMcqChoiceSchema).max(10).optional(),
  answer_hint: ExtractedAnswerHintSchema.nullish(),
});

const ExtractionConfidenceSchema = z.object({
  problem_type_confidence: AnswerConfidenceSchema.default('medium'),
  content_quality: z
    .enum(['clear', 'partially_unclear', 'unclear'])
    .default('clear'),
  has_math: z.boolean().default(false),
  warnings: z.array(z.string()).optional(),
});

// External runs have no access to the user's tag list, so the pasted shape
// only carries plain new-tag name suggestions. Elements are accepted loosely
// (external models emit empties/overlong names); dedupeTagNames filters them
// instead of failing the whole paste.
const PastedSuggestedTagsSchema = z.object({
  new_tag_names: z.array(z.string()).max(20).optional(),
});

export const ProblemExtractionSchema = z.object({
  title: z.string().min(1).max(200),
  /** Shared stem; empty for a single self-contained part. */
  content: z.string().default(''),
  parts: z
    .array(ExtractedPartSchema)
    .min(1)
    .max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  suggest_image_asset: z.boolean().default(false),
  suggested_tags: PastedSuggestedTagsSchema.nullish(),
  confidence: ExtractionConfidenceSchema.optional(),
});

export type ExtractedPart = z.infer<typeof ExtractedPartSchema>;
export type ProblemExtraction = z.infer<typeof ProblemExtractionSchema>;

// Legacy single-part shape (pre-shell responses / older prompts): tolerated
// on paste and converted into a one-part shell.
const LegacyExtractionSchema = z.object({
  problem_type: z.enum(PROBLEM_TYPE_VALUES),
  title: z.string().min(1).max(200),
  content: z.string().default(''),
  mcq_choices: z.array(ExtractedMcqChoiceSchema).max(10).optional(),
  answer_hint: ExtractedAnswerHintSchema.nullish(),
  suggest_image_asset: z.boolean().default(false),
  suggested_tags: PastedSuggestedTagsSchema.nullish(),
  confidence: ExtractionConfidenceSchema.optional(),
});

export interface ParsedExtraction {
  title: string;
  content: string;
  parts: ExtractedPart[];
  suggest_image_asset: boolean;
  new_tag_names: string[];
  confidence?: z.infer<typeof ExtractionConfidenceSchema>;
}

export type ParseExtractionResult =
  | { ok: true; data: ParsedExtraction }
  | { ok: false; error: 'invalid_json' | 'invalid_schema'; detail: string };

/** Strips markdown code fences some models wrap around JSON output. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Parses text pasted by the user (the JSON an external model produced from
 * our off-platform prompt). Zero network, zero quota: validation happens
 * entirely client-side against the shared shell-model schema.
 */
export function parsePastedExtraction(raw: string): ParseExtractionResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(raw));
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_json',
      detail: err instanceof Error ? err.message : 'JSON parse failed',
    };
  }

  const shell = ProblemExtractionSchema.safeParse(json);
  if (shell.success) {
    return { ok: true, data: normaliseShell(shell.data) };
  }

  const legacy = LegacyExtractionSchema.safeParse(json);
  if (legacy.success) {
    const d = legacy.data;
    return {
      ok: true,
      data: normaliseShell({
        title: d.title,
        content: '',
        parts: [
          {
            index: 1,
            label: null,
            type: d.problem_type,
            content: d.content,
            full_marks: null,
            mcq_choices: d.mcq_choices,
            answer_hint: d.answer_hint,
          },
        ],
        suggest_image_asset: d.suggest_image_asset,
        suggested_tags: d.suggested_tags,
        confidence: d.confidence,
      }),
    };
  }

  const issue = shell.error.issues[0];
  return {
    ok: false,
    error: 'invalid_schema',
    detail: issue
      ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
      : 'schema validation failed',
  };
}

/** Sorts parts by index, dedupes hint fields against each part's type. */
function normaliseShell(data: ProblemExtraction): ParsedExtraction {
  const parts = [...data.parts]
    .sort((a, b) => a.index - b.index)
    .map((part, i) => ({ ...part, index: i + 1 }))
    .map(part => ({ ...part, answer_hint: cleanHint(part) }));
  return {
    title: data.title.trim(),
    content: data.content,
    parts,
    suggest_image_asset: data.suggest_image_asset,
    new_tag_names: dedupeTagNames(data.suggested_tags?.new_tag_names ?? []),
    confidence: data.confidence,
  };
}

function dedupeTagNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 30) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Canonicalises a compact choice-answer string against the part's declared
 * choices. Accepts the pipeline's concatenated form ("BC"), human/model
 * separators (",", "、", "/", spaces) and any letter case, and returns the
 * matching ids in declared-choice order with duplicates removed. The result
 * is what both `cleanHint` and the storage mapping must agree on.
 */
export function parseChoiceIds(
  raw: string,
  choices: { id: string }[] | undefined
): string[] {
  const declared = choices ?? [];
  const text = raw.toUpperCase();
  const matched = new Set<string>();
  // Longest ids first so "A1A2" tokenises even when "A" is also a choice.
  const candidates = [...declared].sort((a, b) => b.id.length - a.id.length);
  let cursor = 0;
  while (cursor < text.length) {
    const hit = candidates.find(
      choice =>
        choice.id.length > 0 &&
        !matched.has(choice.id) &&
        text.startsWith(choice.id.toUpperCase(), cursor)
    );
    if (hit) {
      matched.add(hit.id);
      cursor += hit.id.length;
      continue;
    }
    cursor += 1;
  }
  return declared.map(choice => choice.id).filter(id => matched.has(id));
}

/**
 * Mirrors the server-side answer_hint post-processing: zero out fields that
 * don't match the part type, canonicalise choice ids, drop empty hints.
 * `droppedReason` is set whenever the caller supplied answer data that did
 * not survive — the silent-loss case callers must be told about.
 */
export function cleanHintWithReason(part: ExtractedPart): {
  hint: ExtractedPart['answer_hint'] | null;
  droppedReason: string | null;
} {
  const hint = part.answer_hint;
  if (!hint) return { hint: null, droppedReason: null };
  const isChoice =
    part.type === 'single_choice' || part.type === 'multi_choice';
  const isShortLike =
    part.type === 'fill_blank' || part.type === 'short_answer';
  const providedChoice = hint.mcq_correct_choice_id ?? '';
  const rawChoiceId = isChoice ? providedChoice : '';
  const choiceIds =
    rawChoiceId.length > 0 ? parseChoiceIds(rawChoiceId, part.mcq_choices) : [];
  const singleOverflow = part.type === 'single_choice' && choiceIds.length > 1;
  const shortValue = isShortLike ? hint.short_answer_value : null;
  const working = part.type === 'essay' ? hint.extended_working : null;
  const lowConfidence =
    hint.answer_confidence === 'low' && part.type !== 'essay';

  const cleaned = {
    ...hint,
    mcq_correct_choice_id:
      !singleOverflow && choiceIds.length > 0 ? choiceIds.join('') : null,
    short_answer_value: shortValue ?? null,
    short_answer_is_numeric: shortValue
      ? (hint.short_answer_is_numeric ?? null)
      : null,
    extended_working: working ?? null,
  };
  const hasData = Boolean(
    cleaned.mcq_correct_choice_id ||
    cleaned.short_answer_value ||
    cleaned.extended_working
  );
  if (hasData && !lowConfidence) return { hint: cleaned, droppedReason: null };

  const supplied = [
    providedChoice && 'mcq_correct_choice_id',
    hint.short_answer_value && 'short_answer_value',
    hint.extended_working && 'extended_working',
  ].filter((field): field is string => Boolean(field));
  if (supplied.length === 0) return { hint: null, droppedReason: null };

  let droppedReason: string;
  if (lowConfidence) {
    droppedReason = `its answer confidence is "${hint.answer_confidence}", and low-confidence answers are not auto-applied to a ${part.type} part`;
  } else if (singleOverflow) {
    droppedReason = `a single_choice part takes exactly one choice id, but ${JSON.stringify(rawChoiceId)} matched ${choiceIds.length}`;
  } else if (isChoice && providedChoice) {
    droppedReason = `no id in ${JSON.stringify(providedChoice)} matches this part's mcq_choices`;
  } else {
    droppedReason = `a ${part.type} part cannot store ${supplied.join(', ')}`;
  }
  return { hint: null, droppedReason };
}

/** The hint that survives post-processing, or null when nothing applies. */
export function cleanHint(
  part: ExtractedPart
): ExtractedPart['answer_hint'] | null {
  return cleanHintWithReason(part).hint;
}
