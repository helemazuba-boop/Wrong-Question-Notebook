import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SkillRetrievalLock } from '@/lib/problem-marks/registry-artifact';

const revisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonBlankSchema = z.string().trim().min(1);
const stableMarkKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.skill\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);

const profileSchema = z
  .object({
    profile_id: z.literal('skill-rag-qwen37-v1'),
    provider_protocol: z.literal('dashscope-qwen37-native-v1'),
    provider: z.literal('dashscope'),
    endpoint: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
    model: z.literal('qwen3.7-text-embedding'),
    model_identity_policy: z.literal('hosted_alias'),
    model_identity: z.literal('qwen3.7-text-embedding'),
    dimension: z.literal(2560),
    encoding_format: z.literal('float'),
    normalization: z.literal('l2'),
    document_contract: z
      .object({
        text_type: z.literal('document'),
        output_type: z.literal('dense'),
      })
      .strict(),
    query_contract: z
      .object({
        text_type: z.literal('query'),
        output_type: z.literal('dense'),
        instruct: z.literal(
          'Given a Chinese high school physics problem, retrieve the most relevant problem-solving skill or method needed to solve it.'
        ),
      })
      .strict(),
    document_template_version: nonBlankSchema,
    query_template_version: nonBlankSchema,
    tokenizer: z.null(),
  })
  .strict();

export const SkillRetrievalArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    profile_id: z.literal('skill-rag-qwen37-v1'),
    profile_fingerprint: revisionSchema,
    source_corpus_sha256: sha256Schema,
    source_documents_sha256: sha256Schema,
    source_vectors_sha256: sha256Schema,
    source_vector_cache_key: sha256Schema,
    embedding_profile: profileSchema,
    documents: z.array(
      z
        .object({
          stable_key: stableMarkKeySchema,
          subject: nonBlankSchema,
          title: nonBlankSchema,
          retrieval_text: nonBlankSchema,
          document_revision: z.number().int().positive(),
          source_location: nonBlankSchema,
          status: z.literal('active'),
          vector: z.array(z.number().finite()),
        })
        .strict()
    ),
  })
  .strict();

export const SkillRetrievalManifestSchema = z
  .object({
    schema_version: z.literal(1),
    representation_revision: revisionSchema,
    artifact: nonBlankSchema,
    artifact_sha256: sha256Schema,
    profile_id: z.literal('skill-rag-qwen37-v1'),
    profile_fingerprint: revisionSchema,
    provider_protocol: z.literal('dashscope-qwen37-native-v1'),
    provider: z.literal('dashscope'),
    model: z.literal('qwen3.7-text-embedding'),
    model_identity_policy: z.literal('hosted_alias'),
    model_identity: z.literal('qwen3.7-text-embedding'),
    dimension: z.literal(2560),
    normalization: z.literal('l2'),
    source_corpus_sha256: sha256Schema,
    source_documents_sha256: sha256Schema,
    source_vectors_sha256: sha256Schema,
    source_vector_cache_key: sha256Schema,
    documents_sha256: sha256Schema,
    vectors_sha256: sha256Schema,
    document_count: z.number().int().positive(),
  })
  .strict();

export type SkillRetrievalProfile = z.infer<typeof profileSchema>;
export type SkillRetrievalArtifact = z.infer<
  typeof SkillRetrievalArtifactSchema
>;
export type SkillRetrievalManifest = z.infer<
  typeof SkillRetrievalManifestSchema
>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// The profile fingerprint is defined over the Registry's canonical
// serialization, which preserves the published key order. A zod `.strict()`
// parse rebuilds the object in schema-declaration order, so re-serializing the
// parsed value would not reproduce the canonical bytes. Fingerprint the raw
// parsed value (which keeps file key order) instead of the zod output.
function profileFingerprint(profile: unknown): string {
  return `sha256:${sha256(`${JSON.stringify(profile)}\n`)}`;
}

function assertNormalized(vector: number[], stableKey: string): void {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error(
      `Skill retrieval vector is not L2-normalized: ${stableKey}`
    );
  }
}

export function parseSkillRetrievalArtifact(
  artifactText: string,
  manifestText: string,
  lock: SkillRetrievalLock
): SkillRetrievalArtifact {
  const artifactHash = sha256(artifactText);
  const manifestHash = sha256(manifestText);
  if (artifactHash !== lock.artifact_sha256) {
    throw new Error('Skill retrieval artifact hash does not match the lock');
  }
  if (manifestHash !== lock.manifest_sha256) {
    throw new Error('Skill retrieval manifest hash does not match the lock');
  }

  const rawArtifactValue = JSON.parse(artifactText) as {
    embedding_profile?: unknown;
  };
  const artifact = SkillRetrievalArtifactSchema.parse(rawArtifactValue);
  const manifest = SkillRetrievalManifestSchema.parse(
    JSON.parse(manifestText) as unknown
  );
  if (
    artifactHash !== manifest.artifact_sha256 ||
    `sha256:${artifactHash}` !== manifest.representation_revision ||
    artifact.profile_fingerprint !==
      profileFingerprint(rawArtifactValue.embedding_profile)
  ) {
    throw new Error('Skill retrieval manifest does not match artifact bytes');
  }
  for (const [name, actual, expected] of [
    ['profile_id', artifact.profile_id, lock.profile_id],
    [
      'profile_fingerprint',
      artifact.profile_fingerprint,
      lock.profile_fingerprint,
    ],
    [
      'representation_revision',
      manifest.representation_revision,
      lock.representation_revision,
    ],
    ['provider_protocol', manifest.provider_protocol, lock.provider_protocol],
  ] as const) {
    if (actual !== expected) {
      throw new Error(`Skill retrieval ${name} does not match the lock`);
    }
  }

  const seen = new Set<string>();
  for (const document of artifact.documents) {
    if (seen.has(document.stable_key)) {
      throw new Error(`Duplicate Skill retrieval key: ${document.stable_key}`);
    }
    seen.add(document.stable_key);
    if (document.vector.length !== artifact.embedding_profile.dimension) {
      throw new Error(
        `Skill retrieval vector dimension mismatch: ${document.stable_key}`
      );
    }
    assertNormalized(document.vector, document.stable_key);
  }
  return artifact;
}
