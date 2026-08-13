import 'server-only';

import { z } from 'zod';

interface SkillQueryInput {
  title: unknown;
  content?: unknown;
  parts?: unknown;
  [key: string]: unknown;
}

const nonBlankTextSchema = z.string().trim().min(1).max(20_000);
export const SKILL_QUERY_TEMPLATE_VERSION = 'skill-question-instruction-v1';
const queryTemplateVersion = SKILL_QUERY_TEMPLATE_VERSION;

const partSchema = z
  .object({
    index: z.number().int().min(1).max(10),
    type: nonBlankTextSchema.optional(),
    label: nonBlankTextSchema.optional(),
    content: nonBlankTextSchema.optional(),
    choices: z
      .array(
        z
          .object({
            text: nonBlankTextSchema,
          })
          .strict()
      )
      .max(10)
      .optional(),
  })
  .strict();

export const SkillRetrievalQueryProblemSchema = z
  .object({
    title: nonBlankTextSchema,
    content: nonBlankTextSchema.nullable().optional(),
    parts: z.array(partSchema).min(1).max(10),
  })
  .strict();

export type SkillRetrievalQueryProblem = z.infer<
  typeof SkillRetrievalQueryProblemSchema
>;

export interface SkillRetrievalQueryText {
  templateVersion: string;
  text: string;
}

// Problem Part fields (see lib/types.ts ProblemPart) that carry answers or
// scoring and must never reach a retrieval query. answer_config is reduced to
// visible choice text only; every other field it holds (correct ids,
// acceptable answers, numeric config, ...) is dropped. Any other Part key is
// preserved so the strict schema can reject structure we have not audited.
const STRIPPED_PART_KEYS = new Set([
  'correct_answer',
  'full_marks',
  'answer_config',
]);

// Only the visible choice text may leave answer_config; choice ids and any
// correctness metadata stay behind the security boundary.
function choiceTexts(answerConfig: unknown): { text: string }[] | undefined {
  if (!answerConfig || typeof answerConfig !== 'object') return undefined;
  const choices = (answerConfig as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const texts = choices
    .map(choice =>
      choice && typeof choice === 'object' && 'text' in choice
        ? String((choice as { text: unknown }).text).trim()
        : ''
    )
    .filter(text => text.length > 0);
  return texts.length > 0 ? texts.map(text => ({ text })) : undefined;
}

function projectedPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const record = part as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRIPPED_PART_KEYS.has(key)) continue;
    projected[key] = value;
  }
  const choices = choiceTexts(record.answer_config);
  if (choices) projected.choices = choices;
  return projected;
}

export function projectSkillRetrievalQueryProblem(
  input: SkillQueryInput
): unknown {
  const content =
    input.content === null || typeof input.content === 'string'
      ? input.content
      : undefined;
  const parts = Array.isArray(input.parts)
    ? input.parts.map(projectedPart)
    : input.parts;
  return {
    title: input.title,
    ...(content && content.trim() ? { content } : {}),
    parts,
  };
}

export function parseSkillRetrievalQueryProblem(
  input: SkillQueryInput
): SkillRetrievalQueryProblem {
  return SkillRetrievalQueryProblemSchema.parse(
    projectSkillRetrievalQueryProblem(input)
  );
}

export function buildSkillRetrievalQueryText(
  problem: SkillRetrievalQueryProblem
): SkillRetrievalQueryText {
  const sections: string[] = [
    `Problem title:\n${problem.title}`,
    ...(problem.content ? [`Problem statement:\n${problem.content}`] : []),
    ...problem.parts.map(part =>
      [
        `Part ${part.index}${part.label ? ` (${part.label})` : ''}${
          part.type ? ` [${part.type}]` : ''
        }`,
        ...(part.content ? [part.content] : []),
        ...(part.choices?.map(
          (choice, index) =>
            `Choice ${String.fromCharCode(65 + index)}: ${choice.text}`
        ) ?? []),
      ].join('\n')
    ),
  ];
  return {
    templateVersion: queryTemplateVersion,
    text: sections.join('\n\n'),
  };
}

export function buildSkillRetrievalQuery(
  input: SkillQueryInput
): SkillRetrievalQueryText {
  return buildSkillRetrievalQueryText(parseSkillRetrievalQueryProblem(input));
}
