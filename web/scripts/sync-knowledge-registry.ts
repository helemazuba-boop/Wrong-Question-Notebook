// Verify and synchronize the exact Knowledge Registry revision pinned by
// knowledge-registry.lock.json. Production credentials stay server-side.
//
// Run from web/ with Node >= 24:
//   node scripts/sync-knowledge-registry.ts --verify-only
//   node scripts/sync-knowledge-registry.ts --artifact vendor/knowledge-registry/registry.json

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  KnowledgeRegistryLockSchema,
  verifyKnowledgeRegistryArtifact,
} from '../lib/problem-marks/registry-artifact.ts';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const lockPath = path.join(webDir, 'knowledge-registry.lock.json');
const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const artifactIndex = args.indexOf('--artifact');
const localArtifactPath =
  artifactIndex === -1
    ? null
    : path.resolve(args[artifactIndex + 1] ?? missingArtifactPath());

function missingArtifactPath(): never {
  throw new Error('--artifact requires a file path');
}

const lock = KnowledgeRegistryLockSchema.parse(
  JSON.parse(await readFile(lockPath, 'utf8'))
);
const artifactText = localArtifactPath
  ? await readFile(localArtifactPath, 'utf8')
  : await fetchPinnedArtifact(lock.artifact_url);
const artifact = verifyKnowledgeRegistryArtifact(lock, artifactText);

console.log(
  [
    'Knowledge Registry lock verified',
    `source=${lock.source_sha}`,
    `schema=${artifact.schema_version}`,
    `subjects=${artifact.subjects.length}`,
    `marks=${artifact.marks.length}`,
    `sha256=${lock.content_sha256}`,
  ].join(' ')
);

if (verifyOnly) process.exit(0);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !secretKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set'
  );
}

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await supabase.rpc('sync_knowledge_registry_revision', {
  p_source_repository: lock.repository,
  p_source_sha: lock.source_sha,
  p_schema_version: lock.schema_version,
  p_content_sha256: lock.content_sha256,
  p_artifact_text: artifactText,
});
if (error) throw new Error(`Knowledge Registry sync failed: ${error.message}`);

const result = data as Record<string, unknown>;
for (const [key, expected] of [
  ['source_sha', lock.source_sha],
  ['content_sha256', lock.content_sha256],
  ['schema_version', lock.schema_version],
  ['subjects', artifact.subjects.length],
  ['marks', artifact.marks.length],
] as const) {
  if (result[key] !== expected) {
    throw new Error(`Knowledge Registry sync response mismatched ${key}`);
  }
}

console.log(
  `Knowledge Registry synchronized revision_id=${String(result.revision_id)}`
);

async function fetchPinnedArtifact(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(
      `Unable to download pinned Registry artifact: ${response.status}`
    );
  }
  return response.text();
}
