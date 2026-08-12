import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSkillRetrievalArtifact } from '@/lib/problem-marks/retrieval/skill-artifact';
import type { SkillRetrievalLock } from '@/lib/problem-marks/registry-artifact';

function profile() {
  return {
    profile_id: 'skill-rag-qwen37-v1',
    provider_protocol: 'dashscope-qwen37-native-v1',
    provider: 'dashscope',
    endpoint:
      'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
    model: 'qwen3.7-text-embedding',
    model_identity_policy: 'hosted_alias',
    model_identity: 'qwen3.7-text-embedding',
    dimension: 2560,
    encoding_format: 'float',
    normalization: 'l2',
    document_contract: { text_type: 'document', output_type: 'dense' },
    query_contract: {
      text_type: 'query',
      output_type: 'dense',
      instruct:
        'Given a Chinese high school physics problem, retrieve the most relevant problem-solving skill or method needed to solve it.',
    },
    document_template_version: 'skill-doc-v1',
    query_template_version: 'skill-query-v1',
    tokenizer: null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(): string {
  return `sha256:${sha256(`${JSON.stringify(profile())}\n`)}`;
}

function unitVector(position: number): number[] {
  return Array.from({ length: 2560 }, (_value, index) =>
    index === position ? 1 : 0
  );
}

function source() {
  const artifact = {
    schema_version: 1,
    profile_id: 'skill-rag-qwen37-v1',
    profile_fingerprint: fingerprint(),
    source_corpus_sha256: 'a'.repeat(64),
    source_documents_sha256: 'b'.repeat(64),
    source_vectors_sha256: 'c'.repeat(64),
    source_vector_cache_key: 'd'.repeat(64),
    embedding_profile: profile(),
    documents: [
      {
        stable_key: 'physics.skill.move.001',
        subject: 'physics',
        title: '正交分解',
        retrieval_text: 'document',
        document_revision: 1,
        source_location: 'source#move-001',
        status: 'active',
        vector: unitVector(0),
      },
    ],
  };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactHash = sha256(artifactText);
  const manifest = {
    schema_version: 1,
    representation_revision: `sha256:${artifactHash}`,
    artifact: 'skill-retrieval/skill-rag-qwen37-v1.json',
    artifact_sha256: artifactHash,
    profile_id: artifact.profile_id,
    profile_fingerprint: artifact.profile_fingerprint,
    provider_protocol: artifact.embedding_profile.provider_protocol,
    provider: artifact.embedding_profile.provider,
    model: artifact.embedding_profile.model,
    model_identity_policy: artifact.embedding_profile.model_identity_policy,
    model_identity: artifact.embedding_profile.model_identity,
    dimension: 2560,
    normalization: 'l2',
    source_corpus_sha256: artifact.source_corpus_sha256,
    source_documents_sha256: artifact.source_documents_sha256,
    source_vectors_sha256: artifact.source_vectors_sha256,
    source_vector_cache_key: artifact.source_vector_cache_key,
    documents_sha256: 'e'.repeat(64),
    vectors_sha256: 'f'.repeat(64),
    document_count: 1,
  };
  return {
    artifactText,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function lock(artifactText: string, manifestText: string): SkillRetrievalLock {
  const artifactHash = sha256(artifactText);
  return {
    profile_id: 'skill-rag-qwen37-v1',
    profile_fingerprint: fingerprint(),
    provider_protocol: 'dashscope-qwen37-native-v1',
    representation_revision: `sha256:${artifactHash}`,
    artifact_url: 'https://example.test/artifact.json',
    artifact_sha256: artifactHash,
    manifest_url: 'https://example.test/manifest.json',
    manifest_sha256: sha256(manifestText),
  };
}

describe('Skill retrieval artifact verifier', () => {
  it('verifies lock, manifest, profile, dimensions, and normalization', () => {
    const { artifactText, manifestText } = source();
    const artifact = parseSkillRetrievalArtifact(
      artifactText,
      manifestText,
      lock(artifactText, manifestText)
    );
    expect(artifact.documents).toHaveLength(1);
    expect(artifact.embedding_profile.model).toBe('qwen3.7-text-embedding');
  });

  it('rejects tampered bytes and cross-profile identity swaps', () => {
    const { artifactText, manifestText } = source();
    const validLock = lock(artifactText, manifestText);
    expect(() =>
      parseSkillRetrievalArtifact(`${artifactText} `, manifestText, validLock)
    ).toThrow(/artifact hash/);
    expect(() =>
      parseSkillRetrievalArtifact(artifactText, manifestText, {
        ...validLock,
        profile_fingerprint: `sha256:${'0'.repeat(64)}`,
      })
    ).toThrow(/profile_fingerprint/);
    const wrongProfile = {
      ...JSON.parse(artifactText),
      embedding_profile: {
        ...JSON.parse(artifactText).embedding_profile,
        model: 'nvidia/nemotron-3-embed-1b',
      },
    };
    const wrongText = `${JSON.stringify(wrongProfile, null, 2)}\n`;
    expect(() =>
      parseSkillRetrievalArtifact(wrongText, manifestText, validLock)
    ).toThrow(/artifact hash|does not match/);
  });
});
