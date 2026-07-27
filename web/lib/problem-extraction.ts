import { z } from 'zod';
import { PROBLEM_TYPE_VALUES } from './schemas';
import { PROBLEM_CONSTANTS } from './constants';

// =====================================================
// Shell-model problem extraction contract
//
// Single source of truth for the structured JSON a model (the platform's
// vision route OR an external LLM run by the user) produces when extracting
// a problem. Both consumers share this schema:
//   - /api/ai/extract-problem validates/normalises its model output with it
//   - the paste tab in ImageScanUploader validates user-pasted JSON with it
// A problem is a shell (shared stem in `content`) plus 1..N typed parts,
// matching the gaokao shell model used by the problem form and storage.
// =====================================================

const AnswerConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const ExtractedAnswerHintSchema = z.object({
  mcq_correct_choice_id: z.string().nullish(),
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
 * Mirrors the server-side answer_hint post-processing: zero out fields that
 * don't match the part type, validate choice ids, drop empty hints.
 */
export function cleanHint(
  part: ExtractedPart
): ExtractedPart['answer_hint'] | null {
  const hint = part.answer_hint;
  if (!hint) return null;
  const isChoice =
    part.type === 'single_choice' || part.type === 'multi_choice';
  const isShortLike =
    part.type === 'fill_blank' || part.type === 'short_answer';

  if (hint.answer_confidence === 'low' && part.type !== 'essay') {
    return null;
  }

  const cleaned = { ...hint };
  if (!isChoice) cleaned.mcq_correct_choice_id = null;
  if (!isShortLike) {
    cleaned.short_answer_value = null;
    cleaned.short_answer_is_numeric = null;
  }
  if (part.type !== 'essay') cleaned.extended_working = null;

  if (isChoice && cleaned.mcq_correct_choice_id) {
    const validIds = new Set((part.mcq_choices ?? []).map(c => c.id));
    const ids =
      part.type === 'multi_choice'
        ? cleaned.mcq_correct_choice_id.split('')
        : [cleaned.mcq_correct_choice_id];
    if (!ids.every(id => validIds.has(id))) {
      cleaned.mcq_correct_choice_id = null;
    }
  }

  const hasData =
    cleaned.mcq_correct_choice_id ||
    cleaned.short_answer_value ||
    cleaned.extended_working;
  return hasData ? cleaned : null;
}
