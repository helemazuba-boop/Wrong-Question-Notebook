import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROBLEM_STUDY_SCHEMA_SHA256,
  problemManifestRequestSchema,
  problemManifestSuccessSchema,
  problemObservationRequestSchema,
  problemObservationSuccessSchema,
  problemPackMetaSchema,
  problemPackRowSchema,
} from '@/lib/problem-study-v1';

const CONTRACT_DIR = path.join(process.cwd(), 'contracts', 'problem-study-v1');

function readJson(relative: string) {
  return JSON.parse(readFileSync(path.join(CONTRACT_DIR, relative), 'utf8'));
}

describe('problem-study-v1 contract', () => {
  it('pins the schema hash across code, manifest, and schema file', () => {
    const schemaBytes = readFileSync(
      path.join(CONTRACT_DIR, 'problem-study-v1.schema.json')
    );
    const digest = createHash('sha256').update(schemaBytes).digest('hex');
    const manifest = readJson('manifest.json');
    expect(digest).toBe(PROBLEM_STUDY_SCHEMA_SHA256);
    expect(manifest.schema_sha256).toBe(PROBLEM_STUDY_SCHEMA_SHA256);
    expect(manifest.contract).toBe('problem-study-v1');
    expect(manifest.pack_schema_version).toBe(1);
  });

  const validCases: Array<
    [string, { safeParse: (v: unknown) => { success: boolean } }]
  > = [
    ['manifest-request', problemManifestRequestSchema],
    ['manifest-response', problemManifestSuccessSchema],
    ['observation-request', problemObservationRequestSchema],
    ['observation-response', problemObservationSuccessSchema],
    ['observation-skip-response', problemObservationSuccessSchema],
    ['pack-meta', problemPackMetaSchema],
    ['pack-row', problemPackRowSchema],
  ];

  it.each(validCases)('accepts the valid %s fixture', (name, schema) => {
    const result = schema.safeParse(readJson(`fixtures/valid/${name}.json`));
    expect(result.success).toBe(true);
  });

  it('rejects an observation with an unknown review action', () => {
    const result = problemObservationRequestSchema.safeParse(
      readJson('fixtures/invalid/invalid-action.json')
    );
    expect(result.success).toBe(false);
  });

  it('rejects an observation whose request id is too short', () => {
    const result = problemObservationRequestSchema.safeParse(
      readJson('fixtures/invalid/short-request-id.json')
    );
    expect(result.success).toBe(false);
  });
});
