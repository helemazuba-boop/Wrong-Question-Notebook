import { createHash } from 'node:crypto';
import { z } from 'zod';

const statusSchema = z.enum(['active', 'deprecated']);
const subjectKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const markKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.(?:knowledge|skill)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);
const nonBlankSchema = z.string().trim().min(1);
const stringListSchema = z.array(nonBlankSchema);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const revisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const subjectSchema = z
  .object({
    stable_key: subjectKeySchema,
    name: nonBlankSchema,
    aliases: stringListSchema,
    status: statusSchema,
  })
  .strict();

const markSchema = z
  .object({
    stable_key: markKeySchema,
    name: nonBlankSchema,
    kind: z.enum(['knowledge', 'skill']),
    subject: subjectKeySchema,
    aliases: stringListSchema,
    description: nonBlankSchema.optional(),
    parent: markKeySchema.optional(),
    include: stringListSchema,
    exclude: stringListSchema,
    status: statusSchema,
  })
  .strict();

export const KnowledgeRegistryArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    subjects: z.array(subjectSchema),
    marks: z.array(markSchema),
  })
  .strict()
  .superRefine((artifact, context) => {
    const subjectKeys = new Set<string>();
    for (const subject of artifact.subjects) {
      if (subjectKeys.has(subject.stable_key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Subject stable key: ${subject.stable_key}`,
        });
      }
      subjectKeys.add(subject.stable_key);
    }

    const marks = new Map<string, z.infer<typeof markSchema>>();
    for (const mark of artifact.marks) {
      if (marks.has(mark.stable_key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Mark stable key: ${mark.stable_key}`,
        });
      }
      marks.set(mark.stable_key, mark);
      if (!subjectKeys.has(mark.subject)) {
        context.addIssue({
          code: 'custom',
          message: `Mark ${mark.stable_key} references unknown Subject`,
        });
      }
      if (!mark.stable_key.startsWith(`${mark.subject}.${mark.kind}.`)) {
        context.addIssue({
          code: 'custom',
          message: `Mark ${mark.stable_key} has an inconsistent identity`,
        });
      }
    }

    for (const mark of artifact.marks) {
      if (!mark.parent) continue;
      const parent = marks.get(mark.parent);
      if (
        !parent ||
        parent.subject !== mark.subject ||
        parent.kind !== mark.kind
      ) {
        context.addIssue({
          code: 'custom',
          message: `Mark ${mark.stable_key} has an invalid parent`,
        });
      }
    }
  });

export const SkillRetrievalLockSchema = z
  .object({
    profile_id: z.literal('skill-rag-qwen37-v1'),
    profile_fingerprint: revisionSchema,
    provider_protocol: z.literal('dashscope-qwen37-native-v1'),
    representation_revision: revisionSchema,
    artifact_url: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
    artifact_sha256: sha256Schema,
    manifest_url: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
    manifest_sha256: sha256Schema,
  })
  .strict();

export const KnowledgeRegistryLockSchema = z
  .object({
    repository: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
    source_sha: z.string().regex(/^[0-9a-f]{40}$/),
    schema_version: z.literal(1),
    artifact_url: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
    content_sha256: sha256Schema,
    skill_retrieval: SkillRetrievalLockSchema,
  })
  .strict()
  .superRefine((lock, context) => {
    for (const [field, url] of [
      ['artifact_url', lock.artifact_url],
      ['skill_retrieval.artifact_url', lock.skill_retrieval.artifact_url],
      ['skill_retrieval.manifest_url', lock.skill_retrieval.manifest_url],
    ] as const) {
      const pathSegments = new URL(url).pathname.split('/');
      if (!pathSegments.includes(lock.source_sha)) {
        context.addIssue({
          code: 'custom',
          path: field.split('.'),
          message: 'Artifact URL does not reference the locked source SHA',
        });
      }
    }
  });

export type KnowledgeRegistryArtifact = z.infer<
  typeof KnowledgeRegistryArtifactSchema
>;
export type SkillRetrievalLock = z.infer<typeof SkillRetrievalLockSchema>;
export type KnowledgeRegistryLock = z.infer<typeof KnowledgeRegistryLockSchema>;

export function parseKnowledgeRegistryArtifactText(text: string): {
  artifact: KnowledgeRegistryArtifact;
  contentSha256: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Knowledge Registry artifact is not valid JSON');
  }
  return {
    artifact: KnowledgeRegistryArtifactSchema.parse(value),
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export function verifyKnowledgeRegistryArtifact(
  lock: KnowledgeRegistryLock,
  text: string
): KnowledgeRegistryArtifact {
  const parsed = parseKnowledgeRegistryArtifactText(text);
  if (parsed.artifact.schema_version !== lock.schema_version) {
    throw new Error(
      'Knowledge Registry schema version does not match the lock'
    );
  }
  if (parsed.contentSha256 !== lock.content_sha256) {
    throw new Error('Knowledge Registry content hash does not match the lock');
  }
  return parsed.artifact;
}
