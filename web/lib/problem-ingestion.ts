import { z } from 'zod';
import { PROBLEM_CONSTANTS } from '@/lib/constants';
import { PROBLEM_TYPE_VALUES } from '@/lib/schemas';
import type { Json } from '@/lib/database.types';

export const PROBLEM_INGESTION_SCHEMA_VERSION =
  'wqn.problem-ingestion.v1' as const;

export const IngestionContentNodeSchema = z.object({
  kind: z.enum(['text', 'math_inline', 'math_block']),
  value: z.string().max(5000),
});

const IngestionPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const IngestionPageSchema = z.object({
  page_id: z.string().min(1).max(64),
  image_index: z.number().int().min(0).max(99),
  source_asset_id: z.string().min(1).max(500).nullable(),
  coordinate_space: z.literal('normalized_0_1'),
  source_width: z.number().int().positive().nullable(),
  source_height: z.number().int().positive().nullable(),
  provider_width: z.number().int().positive().nullable(),
  provider_height: z.number().int().positive().nullable(),
  rotation_degrees: z.number().min(-360).max(360).nullable(),
});

export const INGESTION_REGION_ROLES = [
  'question',
  'shared_stem',
  'part',
  'option',
  'printed_answer',
  'printed_solution',
  'student_answer',
  'student_work',
  'teacher_mark',
  'figure',
  'table',
  'formula',
  'other',
] as const;

export const IngestionRegionSchema = z.object({
  region_id: z.string().min(1).max(64),
  page_id: z.string().min(1).max(64),
  role: z.enum(INGESTION_REGION_ROLES),
  polygon: z.array(IngestionPointSchema).min(4).max(16),
  text: z.string().max(5000).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const IngestionChoiceSchema = z.object({
  id: z.string().min(1).max(10),
  content: z.array(IngestionContentNodeSchema).max(100),
  region_ids: z.array(z.string().min(1).max(64)).max(50),
});

const IngestionReferenceAnswerSchema = z.object({
  kind: z.enum(['printed_answer', 'printed_solution']),
  choice_ids: z.array(z.string().min(1).max(10)).max(10),
  content: z.array(IngestionContentNodeSchema).max(100),
  confidence: z.number().min(0).max(1).nullable(),
  region_ids: z.array(z.string().min(1).max(64)).max(50),
});

const IngestionPartSchema = z.object({
  part_id: z.string().min(1).max(64),
  index: z.number().int().min(1).max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  label: z.string().max(20).nullable(),
  type: z.enum(PROBLEM_TYPE_VALUES),
  content: z.array(IngestionContentNodeSchema).max(200),
  full_marks: z.number().min(0).max(999).nullable(),
  choices: z.array(IngestionChoiceSchema).max(10),
  reference_answer: IngestionReferenceAnswerSchema.nullable(),
  region_ids: z.array(z.string().min(1).max(64)).max(100),
  visual_region_ids: z.array(z.string().min(1).max(64)).max(100),
  confidence: z.number().min(0).max(1).nullable(),
  warnings: z.array(z.string().max(500)).max(50),
});

const StudentWorkSchema = z.object({
  work_id: z.string().min(1).max(64),
  part_id: z.string().min(1).max(64).nullable(),
  kind: z.enum(['answer', 'working', 'annotation', 'teacher_mark']),
  content: z.array(IngestionContentNodeSchema).max(200),
  region_ids: z.array(z.string().min(1).max(64)).max(100),
  confidence: z.number().min(0).max(1).nullable(),
});

export const IngestionQuestionSchema = z.object({
  question_id: z.string().min(1).max(64),
  number_label: z.string().max(30).nullable(),
  title: z.string().min(1).max(200).nullable(),
  shared_stem: z.array(IngestionContentNodeSchema).max(200),
  parts: z
    .array(IngestionPartSchema)
    .min(1)
    .max(PROBLEM_CONSTANTS.PARTS.MAX_COUNT),
  region_ids: z.array(z.string().min(1).max(64)).max(200),
  visual_region_ids: z.array(z.string().min(1).max(64)).max(200),
  student_work: z.array(StudentWorkSchema).max(100),
  suggested_tags: z.array(z.string().max(30)).max(20),
  confidence: z.number().min(0).max(1).nullable(),
  incomplete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
});

export const ProblemIngestionDocumentSchema = z.object({
  schema_version: z.literal(PROBLEM_INGESTION_SCHEMA_VERSION),
  status: z.enum(['complete', 'partial']),
  pages: z.array(IngestionPageSchema).min(1).max(100),
  regions: z.array(IngestionRegionSchema).max(2000),
  questions: z.array(IngestionQuestionSchema).max(200),
  warnings: z.array(z.string().max(500)).max(100),
});

const CONTENT_NODE_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    kind: {
      type: 'string' as const,
      enum: ['text', 'math_inline', 'math_block'],
    },
    value: { type: 'string' as const },
  },
  required: ['kind', 'value'] as const,
};

const STRING_ARRAY_RESPONSE_SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const },
};

const CONTENT_ARRAY_RESPONSE_SCHEMA = {
  type: 'array' as const,
  items: CONTENT_NODE_RESPONSE_SCHEMA,
};

const POINT_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    x: { type: 'number' as const },
    y: { type: 'number' as const },
  },
  required: ['x', 'y'] as const,
};

const REFERENCE_ANSWER_RESPONSE_SCHEMA = {
  type: 'object' as const,
  nullable: true,
  properties: {
    kind: {
      type: 'string' as const,
      enum: ['printed_answer', 'printed_solution'],
    },
    choice_ids: STRING_ARRAY_RESPONSE_SCHEMA,
    content: CONTENT_ARRAY_RESPONSE_SCHEMA,
    confidence: { type: 'number' as const, nullable: true },
    region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
  },
  required: [
    'kind',
    'choice_ids',
    'content',
    'confidence',
    'region_ids',
  ] as const,
};

const CHOICE_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    content: CONTENT_ARRAY_RESPONSE_SCHEMA,
    region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
  },
  required: ['id', 'content', 'region_ids'] as const,
};

const PART_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    part_id: { type: 'string' as const },
    index: { type: 'integer' as const },
    label: { type: 'string' as const, nullable: true },
    type: { type: 'string' as const, enum: PROBLEM_TYPE_VALUES },
    content: CONTENT_ARRAY_RESPONSE_SCHEMA,
    full_marks: { type: 'number' as const, nullable: true },
    choices: {
      type: 'array' as const,
      items: CHOICE_RESPONSE_SCHEMA,
    },
    reference_answer: REFERENCE_ANSWER_RESPONSE_SCHEMA,
    region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
    visual_region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
    confidence: { type: 'number' as const, nullable: true },
    warnings: STRING_ARRAY_RESPONSE_SCHEMA,
  },
  required: [
    'part_id',
    'index',
    'label',
    'type',
    'content',
    'full_marks',
    'choices',
    'reference_answer',
    'region_ids',
    'visual_region_ids',
    'confidence',
    'warnings',
  ] as const,
};

const STUDENT_WORK_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    work_id: { type: 'string' as const },
    part_id: { type: 'string' as const, nullable: true },
    kind: {
      type: 'string' as const,
      enum: ['answer', 'working', 'annotation', 'teacher_mark'],
    },
    content: CONTENT_ARRAY_RESPONSE_SCHEMA,
    region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
    confidence: { type: 'number' as const, nullable: true },
  },
  required: [
    'work_id',
    'part_id',
    'kind',
    'content',
    'region_ids',
    'confidence',
  ] as const,
};

/** Provider-neutral Structured Output schema for the recognition stage. */
export const PROBLEM_INGESTION_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    schema_version: {
      type: 'string' as const,
      enum: [PROBLEM_INGESTION_SCHEMA_VERSION],
    },
    status: {
      type: 'string' as const,
      enum: ['complete', 'partial'],
    },
    pages: {
      type: 'array' as const,
      minItems: 1,
      items: {
        type: 'object' as const,
        properties: {
          page_id: { type: 'string' as const },
          image_index: { type: 'integer' as const },
          source_asset_id: { type: 'string' as const, nullable: true },
          coordinate_space: {
            type: 'string' as const,
            enum: ['normalized_0_1'],
          },
          source_width: { type: 'integer' as const, nullable: true },
          source_height: { type: 'integer' as const, nullable: true },
          provider_width: { type: 'integer' as const, nullable: true },
          provider_height: { type: 'integer' as const, nullable: true },
          rotation_degrees: { type: 'number' as const, nullable: true },
        },
        required: [
          'page_id',
          'image_index',
          'source_asset_id',
          'coordinate_space',
          'source_width',
          'source_height',
          'provider_width',
          'provider_height',
          'rotation_degrees',
        ] as const,
      },
    },
    regions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          region_id: { type: 'string' as const },
          page_id: { type: 'string' as const },
          role: { type: 'string' as const, enum: INGESTION_REGION_ROLES },
          polygon: {
            type: 'array' as const,
            minItems: 4,
            items: POINT_RESPONSE_SCHEMA,
          },
          text: { type: 'string' as const, nullable: true },
          confidence: { type: 'number' as const, nullable: true },
        },
        required: [
          'region_id',
          'page_id',
          'role',
          'polygon',
          'text',
          'confidence',
        ] as const,
      },
    },
    questions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          question_id: { type: 'string' as const },
          number_label: { type: 'string' as const, nullable: true },
          title: { type: 'string' as const, nullable: true },
          shared_stem: CONTENT_ARRAY_RESPONSE_SCHEMA,
          parts: {
            type: 'array' as const,
            minItems: 1,
            maxItems: PROBLEM_CONSTANTS.PARTS.MAX_COUNT,
            items: PART_RESPONSE_SCHEMA,
          },
          region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
          visual_region_ids: STRING_ARRAY_RESPONSE_SCHEMA,
          student_work: {
            type: 'array' as const,
            items: STUDENT_WORK_RESPONSE_SCHEMA,
          },
          suggested_tags: STRING_ARRAY_RESPONSE_SCHEMA,
          confidence: { type: 'number' as const, nullable: true },
          incomplete: { type: 'boolean' as const },
          warnings: STRING_ARRAY_RESPONSE_SCHEMA,
        },
        required: [
          'question_id',
          'number_label',
          'title',
          'shared_stem',
          'parts',
          'region_ids',
          'visual_region_ids',
          'student_work',
          'suggested_tags',
          'confidence',
          'incomplete',
          'warnings',
        ] as const,
      },
    },
    warnings: STRING_ARRAY_RESPONSE_SCHEMA,
  },
  required: [
    'schema_version',
    'status',
    'pages',
    'regions',
    'questions',
    'warnings',
  ] as const,
};

export type ProblemIngestionDocument = z.infer<
  typeof ProblemIngestionDocumentSchema
>;
export type IngestionContentNode = z.infer<typeof IngestionContentNodeSchema>;

export interface IngestionSourcePage {
  image_index: number;
  source_width: number;
  source_height: number;
  provider_width: number;
  provider_height: number;
}

export interface ProblemCandidateDraft {
  question_id: string;
  number_label: string | null;
  title: string;
  content: string;
  parts: Array<{
    index: number;
    label: string | null;
    type: (typeof PROBLEM_TYPE_VALUES)[number];
    content: string;
    full_marks: number | null;
    mcq_choices: Array<{ id: string; text: string }>;
    answer_hint: {
      mcq_correct_choice_id: string | null;
      short_answer_value: string | null;
      short_answer_is_numeric: boolean | null;
      extended_working: string | null;
      answer_confidence: 'high' | 'medium' | 'low';
    } | null;
  }>;
  suggest_image_asset: boolean;
  new_tag_names: string[];
  confidence: {
    problem_type_confidence: 'high' | 'medium' | 'low';
    content_quality: 'clear' | 'partially_unclear' | 'unclear';
    has_math: boolean;
    warnings: string[];
  };
  source_region_ids: string[];
  visual_region_ids: string[];
  student_work_count: number;
  incomplete: boolean;
}

function confidenceLevel(value: number | null): 'high' | 'medium' | 'low' {
  if (value === null || value < 0.6) return 'low';
  if (value < 0.85) return 'medium';
  return 'high';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function renderIngestionContent(nodes: IngestionContentNode[]): string {
  const rendered = nodes.map(node => {
    if (node.kind === 'math_inline') return `$${node.value}$`;
    if (node.kind === 'math_block') return `\n$$${node.value}$$\n`;
    return node.value;
  });
  return rendered
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function numericText(value: string): boolean {
  return /^[-+]?\d+(?:\.\d+)?$/.test(value.trim());
}

function answerHint(
  part: z.infer<typeof IngestionPartSchema>
): ProblemCandidateDraft['parts'][number]['answer_hint'] {
  const answer = part.reference_answer;
  if (!answer) return null;
  const confidence = confidenceLevel(answer.confidence);
  const content = renderIngestionContent(answer.content);
  const choiceIds = answer.choice_ids.join('');

  if (part.type === 'single_choice' || part.type === 'multi_choice') {
    if (!choiceIds) return null;
    return {
      mcq_correct_choice_id: choiceIds,
      short_answer_value: null,
      short_answer_is_numeric: null,
      extended_working: null,
      answer_confidence: confidence,
    };
  }
  if (part.type === 'fill_blank' || part.type === 'short_answer') {
    if (!content) return null;
    return {
      mcq_correct_choice_id: null,
      short_answer_value: content,
      short_answer_is_numeric: numericText(content),
      extended_working: null,
      answer_confidence: confidence,
    };
  }
  if (!content) return null;
  return {
    mcq_correct_choice_id: null,
    short_answer_value: null,
    short_answer_is_numeric: null,
    extended_working: content,
    answer_confidence: confidence,
  };
}

function fallbackTitle(numberLabel: string | null, position: number): string {
  return numberLabel?.trim()
    ? `Imported Problem ${numberLabel.trim()}`
    : `Imported Problem ${position + 1}`;
}

export function problemCandidatesFromIngestion(
  document: ProblemIngestionDocument
): ProblemCandidateDraft[] {
  return document.questions.map((question, questionIndex) => {
    const parts = [...question.parts]
      .sort((a, b) => a.index - b.index)
      .map((part, partIndex) => ({
        index: partIndex + 1,
        label: part.label,
        type: part.type,
        content: renderIngestionContent(part.content),
        full_marks: part.full_marks,
        mcq_choices: part.choices.map(choice => ({
          id: choice.id,
          text: renderIngestionContent(choice.content),
        })),
        answer_hint: answerHint(part),
      }));
    const allNodes = [
      ...question.shared_stem,
      ...question.parts.flatMap(part => [
        ...part.content,
        ...part.choices.flatMap(choice => choice.content),
      ]),
    ];
    const warnings = uniqueStrings([
      ...document.warnings,
      ...question.warnings,
      ...question.parts.flatMap(part => part.warnings),
      ...(question.student_work.length > 0
        ? [
            'Student handwriting was preserved as ingestion evidence and was not used as the Problem answer key.',
          ]
        : []),
    ]);
    return {
      question_id: question.question_id,
      number_label: question.number_label,
      title:
        question.title?.trim() ||
        fallbackTitle(question.number_label, questionIndex),
      content: renderIngestionContent(question.shared_stem),
      parts,
      suggest_image_asset:
        question.visual_region_ids.length > 0 ||
        question.parts.some(part => part.visual_region_ids.length > 0),
      new_tag_names: uniqueStrings(
        question.suggested_tags.map(tag => tag.trim()).filter(Boolean)
      ).slice(0, 5),
      confidence: {
        problem_type_confidence: confidenceLevel(question.confidence),
        content_quality:
          question.incomplete || document.status === 'partial'
            ? 'partially_unclear'
            : confidenceLevel(question.confidence) === 'low'
              ? 'unclear'
              : 'clear',
        has_math: allNodes.some(node => node.kind !== 'text'),
        warnings,
      },
      source_region_ids: uniqueStrings(question.region_ids),
      visual_region_ids: uniqueStrings([
        ...question.visual_region_ids,
        ...question.parts.flatMap(part => part.visual_region_ids),
      ]),
      student_work_count: question.student_work.length,
      incomplete: question.incomplete,
    };
  });
}

/**
 * Source page geometry is authoritative: a model may locate regions, but it
 * must not define the dimensions of the bytes it received. Unknown or
 * duplicate references are retained as warnings rather than destroying a
 * useful partial recognition result.
 */
export function normalizeProblemIngestionDocument(
  input: ProblemIngestionDocument,
  sourcePages: IngestionSourcePage[]
): ProblemIngestionDocument {
  const pages = sourcePages.map(page => ({
    page_id: `page-${page.image_index + 1}`,
    image_index: page.image_index,
    source_asset_id:
      input.pages.find(candidate => candidate.image_index === page.image_index)
        ?.source_asset_id ?? null,
    coordinate_space: 'normalized_0_1' as const,
    source_width: page.source_width,
    source_height: page.source_height,
    provider_width: page.provider_width,
    provider_height: page.provider_height,
    rotation_degrees:
      input.pages.find(candidate => candidate.image_index === page.image_index)
        ?.rotation_degrees ?? null,
  }));
  const pageIds = new Set(pages.map(page => page.page_id));
  const warnings = [...input.warnings];
  const seenRegionIds = new Set<string>();
  const regions = input.regions.filter(region => {
    if (!pageIds.has(region.page_id)) {
      warnings.push(
        `Dropped region ${region.region_id}: unknown page reference.`
      );
      return false;
    }
    if (seenRegionIds.has(region.region_id)) {
      warnings.push(`Dropped duplicate region id ${region.region_id}.`);
      return false;
    }
    seenRegionIds.add(region.region_id);
    return true;
  });
  const regionIds = new Set(regions.map(region => region.region_id));
  const validRegionIds = (ids: string[], owner: string): string[] =>
    uniqueStrings(ids).filter(regionId => {
      if (regionIds.has(regionId)) return true;
      warnings.push(`${owner} references unknown region ${regionId}.`);
      return false;
    });
  const seenQuestionIds = new Set<string>();
  const questions = input.questions
    .filter(question => {
      if (!seenQuestionIds.has(question.question_id)) {
        seenQuestionIds.add(question.question_id);
        return true;
      }
      warnings.push(`Dropped duplicate question id ${question.question_id}.`);
      return false;
    })
    .map(question => {
      const partIds = new Set(question.parts.map(part => part.part_id));
      return {
        ...question,
        region_ids: validRegionIds(
          question.region_ids,
          `Question ${question.question_id}`
        ),
        visual_region_ids: validRegionIds(
          question.visual_region_ids,
          `Question ${question.question_id}`
        ),
        parts: question.parts.map(part => ({
          ...part,
          region_ids: validRegionIds(part.region_ids, `Part ${part.part_id}`),
          visual_region_ids: validRegionIds(
            part.visual_region_ids,
            `Part ${part.part_id}`
          ),
          choices: part.choices.map(choice => ({
            ...choice,
            region_ids: validRegionIds(
              choice.region_ids,
              `Choice ${part.part_id}/${choice.id}`
            ),
          })),
          reference_answer: part.reference_answer
            ? {
                ...part.reference_answer,
                region_ids: validRegionIds(
                  part.reference_answer.region_ids,
                  `Reference answer ${part.part_id}`
                ),
              }
            : null,
        })),
        student_work: question.student_work.map(work => {
          const partId =
            work.part_id && partIds.has(work.part_id) ? work.part_id : null;
          if (work.part_id && !partId) {
            warnings.push(
              `Student work ${work.work_id} references unknown part ${work.part_id}.`
            );
          }
          return {
            ...work,
            part_id: partId,
            region_ids: validRegionIds(
              work.region_ids,
              `Student work ${work.work_id}`
            ),
          };
        }),
      };
    });
  return ProblemIngestionDocumentSchema.parse({
    ...input,
    pages,
    regions,
    questions,
    status: warnings.length > 0 ? 'partial' : input.status,
    warnings: uniqueStrings(warnings).slice(0, 100),
  });
}

export type ParseProblemIngestionResult =
  | { ok: true; data: ProblemIngestionDocument }
  | { ok: false; error: 'invalid_json' | 'invalid_schema'; detail: string };

export function parseProblemIngestion(
  raw: string
): ParseProblemIngestionResult {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let json: unknown;
  try {
    json = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    return {
      ok: false,
      error: 'invalid_json',
      detail: error instanceof Error ? error.message : 'JSON parse failed',
    };
  }
  const parsed = ProblemIngestionDocumentSchema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: 'invalid_schema',
    detail: issue
      ? `${issue.path.join('.') || '(root)'}: ${issue.message}`
      : 'schema validation failed',
  };
}

/** Private recognition references cannot follow a Problem copied to another owner. */
export function stripProblemIngestionProvenance(source: unknown): Json {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const copyable = { ...(source as Record<string, Json | undefined>) };
  delete copyable.ingestion_id;
  delete copyable.ingestion_schema_version;
  delete copyable.ingestion_question_id;
  delete copyable.source_region_ids;
  delete copyable.visual_region_ids;
  return copyable;
}
