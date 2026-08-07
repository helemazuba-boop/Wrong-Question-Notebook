import { createHash } from 'node:crypto';
import { z } from 'zod';

const statusSchema = z.enum(['active', 'deprecated']);
const subjectKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const markKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.(?:knowledge|skill)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);
const nonBlankSchema = z.string().trim().min(1);
const stringListSchema = z.array(nonBlankSchema);

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
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((lock, context) => {
    const pathSegments = new URL(lock.artifact_url).pathname.split('/');
    if (!pathSegments.includes(lock.source_sha)) {
      context.addIssue({
        code: 'custom',
        path: ['artifact_url'],
        message: 'Artifact URL does not reference the locked source SHA',
      });
    }
  });

export type KnowledgeRegistryArtifact = z.infer<
  typeof KnowledgeRegistryArtifactSchema
>;
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
