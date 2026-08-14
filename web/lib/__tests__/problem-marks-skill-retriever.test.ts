import { describe, expect, it, vi } from 'vitest';
import type { SkillRetrievalLock } from '@/lib/problem-marks/registry-artifact';
import {
  retrieveSkillCandidates,
  SkillRetrievalError,
  type SkillRetrievalRuntime,
} from '@/lib/problem-marks/retrieval/skill-retriever';

function lock(): SkillRetrievalLock {
  return {
    profile_id: 'skill-rag-qwen37-v1',
    profile_fingerprint: `sha256:${'1'.repeat(64)}`,
    provider_protocol: 'dashscope-qwen37-native-v1',
    representation_revision: `sha256:${'2'.repeat(64)}`,
    artifact_url: 'https://example.test/artifact.json',
    artifact_sha256: '3'.repeat(64),
    manifest_url: 'https://example.test/manifest.json',
    manifest_sha256: '4'.repeat(64),
  };
}

function document(key: string, subject: string, vector: number[], title = key) {
  return {
    stable_key: key,
    subject,
    title,
    retrieval_text: title,
    document_revision: 1,
    source_location: `source#${key}`,
    status: 'active' as const,
    vector,
  };
}

function runtime(
  overrides: Partial<SkillRetrievalRuntime> = {}
): SkillRetrievalRuntime {
  return {
    lock: lock(),
    artifact: {
      schema_version: 1,
      profile_id: lock().profile_id,
      profile_fingerprint: lock().profile_fingerprint,
      source_corpus_sha256: 'a'.repeat(64),
      source_documents_sha256: 'b'.repeat(64),
      source_vectors_sha256: 'c'.repeat(64),
      source_vector_cache_key: 'd'.repeat(64),
      embedding_profile: {} as never,
      documents: [
        document('physics.skill.move.001', 'physics', [1, 0], 'Target'),
        document('physics.skill.move.002', 'physics', [0, 1], 'Other'),
        document('physics.skill.move.003', 'physics', [0.8, 0.6], 'Third'),
        document('chemistry.skill.move.001', 'chemistry', [1, 0], 'Cross'),
      ],
    },
    manifest: {
      representation_revision: lock().representation_revision,
    } as never,
    provider: { embed: vi.fn(async () => [[1, 0]]) },
    ...overrides,
  };
}

const query = {
  templateVersion: 'skill-question-instruction-v1',
  text: '一物体受力后沿斜面运动，求加速度。',
};

describe('Skill retriever exact cosine TopK', () => {
  it('returns subject-scoped ranked candidates and stable query provenance', async () => {
    const current = runtime();
    const result = await retrieveSkillCandidates(
      current,
      'physics',
      query,
      new Map()
    );
    expect(current.provider.embed).toHaveBeenCalledWith([query.text], 'query');
    expect(result.profileFingerprint).toBe(lock().profile_fingerprint);
    expect(result.representationRevision).toBe(lock().representation_revision);
    expect(result.candidates.map(candidate => candidate.stable_key)).toEqual([
      'physics.skill.move.001',
      'physics.skill.move.003',
      'physics.skill.move.002',
    ]);
    expect(result.candidates.map(candidate => candidate.rank)).toEqual([
      1, 2, 3,
    ]);
    expect(result.retrievalDebug.candidate_count).toBe(3);
    expect(result.retrievalDebug.subject).toBe('physics');
  });

  it('uses bounded query cache keyed by profile and representation', async () => {
    const cache = new Map();
    const current = runtime();
    await retrieveSkillCandidates(current, 'physics', query, cache);
    await retrieveSkillCandidates(current, 'physics', query, cache);
    expect(current.provider.embed).toHaveBeenCalledTimes(1);
    expect(cache.keys().next().value).toContain(lock().profile_fingerprint);
    expect(cache.keys().next().value).toContain(lock().representation_revision);
  });

  it('separates coverage miss from provider and contract failures', async () => {
    await expect(
      retrieveSkillCandidates(runtime(), 'biology', query, new Map())
    ).rejects.toMatchObject({ code: 'SKILL_RETRIEVAL_COVERAGE_MISS' });

    await expect(
      retrieveSkillCandidates(
        runtime({
          provider: {
            embed: vi.fn(async () => {
              throw new Error('provider failed');
            }),
          },
        }),
        'physics',
        query,
        new Map()
      )
    ).rejects.toThrow('provider failed');

    await expect(
      retrieveSkillCandidates(
        runtime({
          lock: {
            ...lock(),
            profile_fingerprint: `sha256:${'0'.repeat(64)}`,
          },
        }),
        'physics',
        query,
        new Map()
      )
    ).rejects.toBeInstanceOf(SkillRetrievalError);
  });
});
