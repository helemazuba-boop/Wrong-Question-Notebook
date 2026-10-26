import { z } from 'zod';

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.(knowledge|skill)\.[a-z0-9_.]+$/);
const text = z.string().trim().min(1).max(4000);
const location = z.number().int().min(1).max(10).nullable();
export const MarkEvidenceSchema = z.strictObject({
  problem_field: z.string().max(80),
  problem_quote: text,
  document_key: key,
  section_id: z.string().regex(/^s\d{3}$/),
  document_quote: text,
  rationale: z.string().trim().min(1).max(800),
});
export const AgentMarkResultSchema = z.strictObject({
  assignments: z
    .array(
      z.strictObject({
        mark_key: key,
        role: z.enum(['target', 'required']),
        part_index: location,
        evidence: MarkEvidenceSchema,
      })
    )
    .max(80),
  methods: z
    .array(
      z.strictObject({
        mark_key: key,
        preference: z.enum(['recommended', 'alternative']),
        part_index: location,
        evidence: MarkEvidenceSchema,
      })
    )
    .max(40),
  unresolved: z
    .array(
      z.strictObject({
        kind: z.enum(['knowledge', 'skill']),
        part_index: location,
        reason: z.enum([
          'no_registry_match',
          'insufficient_problem_context',
          'missing_image',
          'registry_empty',
          'subject_unmapped',
        ]),
        detail: z.string().max(800),
      })
    )
    .max(40),
});
export type AgentMarkResult = z.infer<typeof AgentMarkResultSchema>;
export const AgentTaskAuthSchema = z.strictObject({
  run_id: z.uuid(),
  task_token: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MARK_TOOL_SCHEMAS = {
  get_mark_context: AgentTaskAuthSchema,
  read_mark_images: AgentTaskAuthSchema.extend({
    image_ids: z
      .array(z.string().regex(/^image_\d+$/))
      .min(1)
      .max(4),
  }),
  submit_mark_result: AgentTaskAuthSchema.extend({
    result: AgentMarkResultSchema,
  }),
  get_mark_receipt: AgentTaskAuthSchema,
};
export const AgentBundleSchema = z.object({
  schema_version: z.literal(1),
  registry_content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  skill_version: z.string().min(1),
  skill: z.string().min(1),
  registry: z.object({
    marks: z.array(
      z.object({
        stable_key: key,
        name: z.string(),
        kind: z.enum(['knowledge', 'skill']),
        subject: z.string(),
        status: z.enum(['active', 'deprecated']),
      })
    ),
  }),
  documents: z.array(
    z.object({
      stable_key: key,
      subject: z.string(),
      kind: z.enum(['knowledge', 'skill']),
      title: z.string(),
      document_revision: z.number().int().positive(),
      source_location: z.string(),
      sections: z.array(
        z.strictObject({ id: z.string().regex(/^s\d{3}$/), text: z.string() })
      ),
    })
  ),
});
export type AgentBundle = z.infer<typeof AgentBundleSchema>;
export function markingEngine(): 'rag' | 'agent' {
  const engine = process.env.PROBLEM_MARKING_ENGINE ?? 'rag';
  if (engine !== 'rag' && engine !== 'agent')
    throw new Error('INVALID_MARKING_ENGINE');
  return engine;
}

/** Exact quotations prove provenance. Applicability remains a semantic evaluation. */
export function validateAgentEvidence(
  result: AgentMarkResult,
  context: {
    subject_key: string | null;
    evidence_fields: Record<string, string>;
    part_indexes: number[];
  },
  bundle: AgentBundle
): void {
  const identities = new Set<string>();
  if (
    !result.assignments.length &&
    !result.methods.length &&
    !result.unresolved.length
  )
    throw new Error('EMPTY_MARK_RESULT');
  for (const item of [...result.assignments, ...result.methods]) {
    const doc = bundle.documents.find(d => d.stable_key === item.mark_key);
    const identity = `${'preference' in item ? 'method' : 'mark'}:${item.part_index}:${item.mark_key}`;
    if (identities.has(identity)) throw new Error('DUPLICATE_MARK_RESULT');
    identities.add(identity);
    if (
      !doc ||
      doc.subject !== context.subject_key ||
      ('preference' in item && doc.kind !== 'skill')
    )
      throw new Error('INVALID_MARK_KEY');
    if (
      item.part_index !== null &&
      !context.part_indexes.includes(item.part_index)
    )
      throw new Error('INVALID_PART_INDEX');
    const e = item.evidence;
    if (
      e.document_key !== item.mark_key ||
      !doc.sections
        .find(s => s.id === e.section_id)
        ?.text.includes(e.document_quote)
    )
      throw new Error('INVALID_DOCUMENT_EVIDENCE');
    if (!context.evidence_fields[e.problem_field]?.includes(e.problem_quote))
      throw new Error('INVALID_PROBLEM_EVIDENCE');
    if (
      item.part_index !== null &&
      e.problem_field.startsWith('parts.') &&
      !e.problem_field.startsWith(`parts.${item.part_index}.`)
    )
      throw new Error('EVIDENCE_PART_MISMATCH');
  }
  for (const item of result.unresolved)
    if (
      item.part_index !== null &&
      !context.part_indexes.includes(item.part_index)
    )
      throw new Error('INVALID_PART_INDEX');
}
