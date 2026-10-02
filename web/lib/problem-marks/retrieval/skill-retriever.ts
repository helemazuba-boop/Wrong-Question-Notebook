import 'server-only';

import { createHash } from 'node:crypto';
import type { SkillRetrievalLock } from '@/lib/problem-marks/registry-artifact';
import type { SkillRetrievalQueryText } from './skill-query';
import type {
  SkillRetrievalArtifact,
  SkillRetrievalManifest,
} from './skill-artifact';
import type { EmbeddingProvider } from './embedding-provider';

export interface SkillRetrievalCandidate {
  stable_key: string;
  title: string;
  score: number;
  rank: number;
}

export type SkillRetrievalFailureCode =
  | 'SKILL_RETRIEVAL_COVERAGE_MISS'
  | 'SKILL_RETRIEVAL_PROVIDER_TRANSIENT'
  | 'SKILL_RETRIEVAL_CONTRACT';

export class SkillRetrievalError extends Error {
  constructor(
    public readonly code: SkillRetrievalFailureCode,
    message: string
  ) {
    super(message);
  }
}

export interface SkillRetrievalResult {
  profileId: string;
  profileFingerprint: string;
  representationRevision: string;
  queryTemplateVersion: string;
  queryHash: string;
  candidates: SkillRetrievalCandidate[];
  retrievalDebug: {
    top_k: number;
    subject: string;
    candidate_count: number;
    min_score: number;
  };
}

// Minimum cosine score for a candidate to be offered to the marking model.
// Disabled by default: the right value depends on the score distribution of real
// queries, which has not been measured. For reference, the 76 published physics
// documents score a median 0.46 against each other (p10 0.38, p90 0.55), so any
// threshold below roughly 0.5 would filter nothing in this embedding space.
// Calibrate against `retrieval_debug.skill[].score` before enabling.
const DEFAULT_MIN_SCORE = 0;

export interface SkillRetrievalRuntime {
  lock: SkillRetrievalLock;
  artifact: SkillRetrievalArtifact;
  manifest: SkillRetrievalManifest;
  provider: EmbeddingProvider;
  maxCacheEntries?: number;
  minScore?: number;
}

export interface QueryCacheEntry {
  queryHash: string;
  candidates: SkillRetrievalCandidate[];
}

const QUERY_CACHE_LIMIT = 128;

function hashQuery(query: SkillRetrievalQueryText): string {
  return createHash('sha256').update(query.text, 'utf8').digest('hex');
}

function assertRuntime(runtime: SkillRetrievalRuntime): void {
  if (
    runtime.artifact.profile_id !== runtime.lock.profile_id ||
    runtime.artifact.profile_fingerprint !== runtime.lock.profile_fingerprint ||
    runtime.manifest.representation_revision !==
      runtime.lock.representation_revision
  ) {
    throw new SkillRetrievalError(
      'SKILL_RETRIEVAL_CONTRACT',
      'Skill retrieval runtime does not match the immutable lock'
    );
  }
}

export async function retrieveSkillCandidates(
  runtime: SkillRetrievalRuntime,
  subject: string,
  query: SkillRetrievalQueryText,
  cache: Map<string, QueryCacheEntry>,
  topK = 10
): Promise<SkillRetrievalResult> {
  assertRuntime(runtime);
  const subjectDocuments = runtime.artifact.documents.filter(
    document => document.subject === subject
  );
  if (subjectDocuments.length === 0) {
    throw new SkillRetrievalError(
      'SKILL_RETRIEVAL_COVERAGE_MISS',
      `Skill retrieval has no documents for Subject: ${subject}`
    );
  }
  const minScore = runtime.minScore ?? DEFAULT_MIN_SCORE;
  const queryHash = hashQuery(query);
  // The subject is part of the key: the same question text is legitimately
  // asked under different Subjects, and the candidate set differs per Subject.
  const cacheKey = `${runtime.artifact.profile_fingerprint}:${runtime.lock.representation_revision}:${subject}:${queryHash}`;
  let candidates = cache.get(cacheKey)?.candidates;
  if (!candidates) {
    const queryVector = await runtime.provider.embed([query.text], 'query');
    const embedding = queryVector[0];
    if (!embedding) {
      throw new SkillRetrievalError(
        'SKILL_RETRIEVAL_CONTRACT',
        'Embedding provider returned no query vector'
      );
    }
    candidates = subjectDocuments
      .map((document, index) => ({
        stable_key: document.stable_key,
        title: document.title,
        score: document.vector.reduce(
          (sum, value, position) => sum + value * embedding[position],
          0
        ),
        index,
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.stable_key.localeCompare(right.stable_key, 'en');
      })
      .filter(candidate => candidate.score >= minScore)
      .slice(0, topK)
      .map(({ index: _index, ...candidate }, position) => ({
        ...candidate,
        rank: position + 1,
      }));
    if (cache.size >= (runtime.maxCacheEntries ?? QUERY_CACHE_LIMIT)) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, { queryHash, candidates });
  }
  return {
    profileId: runtime.artifact.profile_id,
    profileFingerprint: runtime.artifact.profile_fingerprint,
    representationRevision: runtime.lock.representation_revision,
    queryTemplateVersion: query.templateVersion,
    queryHash,
    candidates,
    retrievalDebug: {
      top_k: topK,
      subject,
      candidate_count: subjectDocuments.length,
      min_score: minScore,
    },
  };
}
