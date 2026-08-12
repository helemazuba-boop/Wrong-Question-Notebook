import 'server-only';

import { z } from 'zod';

interface SkillQueryInput {
  title: unknown;
  content?: unknown;
  parts?: unknown;
  [key: string]: unknown;
}

const nonBlankTextSchema = z.string().trim().min(1).max(20_000);
const queryTemplateVersion = 'skill-question-instruction-v1';

const partSchema = z
  .object({
    index: z.number().int().min(1).max(10),
    label: nonBlankTextSchema.optional(),
    type: nonBlankTextSchema.optional(),
    prompt: nonBlankTextSchema,
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

// Fields known to exist on source problem/choice rows that must never reach a
// retrieval query. These are stripped silently; every other key is preserved so
// the strict schema can reject any structure we have not explicitly audited.
const FORBIDDEN_PART_KEYS = new Set(['correct_answer', 'answer_config']);
const FORBIDDEN_CHOICE_KEYS = new Set(['is_correct']);

function projectedChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return choice;
  const record = choice as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!FORBIDDEN_CHOICE_KEYS.has(key)) projected[key] = value;
  }
  return projected;
}

function projectedPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const record = part as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_PART_KEYS.has(key)) continue;
    projected[key] =
      key === 'choices' && Array.isArray(value)
        ? value.map(projectedChoice)
        : value;
  }
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
        part.prompt,
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
