import 'server-only';

import { readFile } from 'node:fs/promises';
import type { KnowledgeRegistryLock } from '@/lib/problem-marks/registry-artifact';
import { parseSkillRetrievalArtifact } from './skill-artifact';
import { createDashScopeEmbeddingProvider } from './embedding-provider';
import type { SkillRetrievalRuntime } from './skill-retriever';

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Unable to load pinned Skill retrieval source: ${response.status}`
    );
  }
  return response.text();
}

export async function loadSkillRetrievalRuntime(
  lock: KnowledgeRegistryLock,
  options: {
    artifactText?: string;
    manifestText?: string;
    artifactPath?: string;
    manifestPath?: string;
  } = {}
): Promise<SkillRetrievalRuntime> {
  const artifactText =
    options.artifactText ??
    (options.artifactPath
      ? await readFile(options.artifactPath, 'utf8')
      : await fetchText(lock.skill_retrieval.artifact_url));
  const manifestText =
    options.manifestText ??
    (options.manifestPath
      ? await readFile(options.manifestPath, 'utf8')
      : await fetchText(lock.skill_retrieval.manifest_url));
  const artifact = parseSkillRetrievalArtifact(
    artifactText,
    manifestText,
    lock.skill_retrieval
  );
  const manifest = JSON.parse(
    manifestText
  ) as SkillRetrievalRuntime['manifest'];
  return {
    lock: lock.skill_retrieval,
    artifact,
    manifest,
    provider: createDashScopeEmbeddingProvider(artifact.embedding_profile),
  };
}
