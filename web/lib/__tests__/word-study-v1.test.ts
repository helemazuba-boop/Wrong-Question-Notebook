import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  WORD_STUDY_SCHEMA_SHA256,
  createWordStudySessionRequestSchema,
  createWordStudySessionSuccessSchema,
  observationMutatesProgress,
  semanticsForWordMode,
  wordCandidatePageRequestSchema,
  wordCandidatePageSuccessSchema,
  wordManifestSuccessSchema,
  wordManifestRequestSchema,
  wordObservationRequestSchema,
  wordObservationSuccessSchema,
  wordSkipObservationRequestSchema,
} from '../word-study-v1';

const contractRoot = resolve(process.cwd(), 'contracts/word-study-v1');

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(resolve(contractRoot, path), 'utf8'));
}

describe('word study v1 contract', () => {
  it('pins the schema hash in code and manifest', () => {
    const schema = readFileSync(
      resolve(contractRoot, 'word-study-v1.schema.json')
    );
    const digest = createHash('sha256').update(schema).digest('hex');
    const manifest = fixture('manifest.json') as { schema_sha256: string };

    expect(digest).toBe(WORD_STUDY_SCHEMA_SHA256);
    expect(manifest.schema_sha256).toBe(digest);
  });

  it.each([
    ['session-request.json', createWordStudySessionRequestSchema],
    ['session-response.json', createWordStudySessionSuccessSchema],
    ['candidate-page-request.json', wordCandidatePageRequestSchema],
    ['candidate-page-response.json', wordCandidatePageSuccessSchema],
    ['observation-request.json', wordObservationRequestSchema],
    ['observation-response.json', wordObservationSuccessSchema],
    // The skip tombstone response shares the observation data envelope.
    ['skip-request.json', wordSkipObservationRequestSchema],
    ['skip-response.json', wordObservationSuccessSchema],
    ['manifest-request.json', wordManifestRequestSchema],
    ['manifest-response.json', wordManifestSuccessSchema],
  ])('accepts valid fixture %s', (name, schema) => {
    expect(schema.safeParse(fixture(`fixtures/valid/${name}`)).success).toBe(
      true
    );
  });

  it('rejects counters outside the exact JSON range', () => {
    expect(
      wordObservationRequestSchema.safeParse(
        fixture('fixtures/invalid/unsafe-sequence.json')
      ).success
    ).toBe(false);
  });

  it.each([
    '2026-07-20T11:42:03.123Z',
    '2026-07-20T11:42:03.123+00:00',
    '2026-07-20T19:42:03.123+08:00',
  ])('accepts RFC 3339 progress timestamps from PostgreSQL: %s', dueAt => {
    const response = fixture(
      'fixtures/valid/observation-response.json'
    ) as Record<string, unknown> & {
      data: Record<string, unknown> & {
        progress: Record<string, unknown>;
      };
    };
    response.data.progress.due_at = dueAt;

    expect(wordObservationSuccessSchema.safeParse(response).success).toBe(true);
  });

  it('maps the three visible modes onto one stable internal semantic set', () => {
    expect(semanticsForWordMode('sequential')).toEqual({
      purpose: 'study',
      ordering: 'sequential',
    });
    expect(semanticsForWordMode('random')).toEqual({
      purpose: 'study',
      ordering: 'guided_random_v1',
    });
    expect(semanticsForWordMode('dictionary')).toEqual({
      purpose: 'lookup',
      ordering: 'lexicographic',
    });
  });

  it('changes progress only after an explicit known/unknown action', () => {
    expect(observationMutatesProgress('known')).toBe(true);
    expect(observationMutatesProgress('unknown')).toBe(true);
    for (const action of [
      'shown',
      'revealed',
      'skipped',
      'looked_up',
    ] as const) {
      expect(observationMutatesProgress(action)).toBe(false);
    }
  });
});
