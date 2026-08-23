import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTE_STUDY_SCHEMA_SHA256,
  candidatePolicyVersionForOrdering,
  createNoteStudySessionRequestSchema,
  createNoteStudySessionSuccessSchema,
  noteCandidatePageRequestSchema,
  noteCandidatePageSuccessSchema,
  noteManifestRequestSchema,
  noteManifestSuccessSchema,
  noteObservationRequestSchema,
  noteObservationSuccessSchema,
  noteSkipObservationRequestSchema,
  observationMutatesProgress,
  semanticsForNoteMode,
} from '@/lib/note-study-v1';

const CONTRACT_DIR = path.join(process.cwd(), 'contracts', 'note-study-v1');

function readJson(relative: string) {
  return JSON.parse(readFileSync(path.join(CONTRACT_DIR, relative), 'utf8'));
}

describe('note-study-v1 contract', () => {
  it('pins the schema hash across code, manifest, and schema file', () => {
    const schemaBytes = readFileSync(
      path.join(CONTRACT_DIR, 'note-study-v1.schema.json')
    );
    const digest = createHash('sha256').update(schemaBytes).digest('hex');
    const manifest = readJson('manifest.json');
    expect(digest).toBe(NOTE_STUDY_SCHEMA_SHA256);
    expect(manifest.schema_sha256).toBe(NOTE_STUDY_SCHEMA_SHA256);
    expect(manifest.contract).toBe('note-study-v1');
  });

  const validCases: Array<
    [string, { safeParse: (v: unknown) => { success: boolean } }]
  > = [
    ['session-request', createNoteStudySessionRequestSchema],
    ['session-response', createNoteStudySessionSuccessSchema],
    ['candidate-page-request', noteCandidatePageRequestSchema],
    ['candidate-page-response', noteCandidatePageSuccessSchema],
    ['observation-request', noteObservationRequestSchema],
    ['observation-response', noteObservationSuccessSchema],
    ['skip-request', noteSkipObservationRequestSchema],
    ['manifest-request', noteManifestRequestSchema],
    ['manifest-response', noteManifestSuccessSchema],
  ];

  it.each(validCases)('accepts the valid %s fixture', (name, schema) => {
    const result = schema.safeParse(readJson(`fixtures/valid/${name}.json`));
    expect(result.success).toBe(true);
  });

  it('rejects an observation with an unsafe sequence counter', () => {
    const result = noteObservationRequestSchema.safeParse(
      readJson('fixtures/invalid/unsafe-sequence.json')
    );
    expect(result.success).toBe(false);
  });

  it('rejects a progress projection that leaks a mastery field', () => {
    const result = noteObservationSuccessSchema.safeParse(
      readJson('fixtures/invalid/mastery-projection.json')
    );
    expect(result.success).toBe(false);
  });

  it('maps note modes to browse purpose and note orderings', () => {
    expect(semanticsForNoteMode('sequential')).toEqual({
      purpose: 'browse',
      ordering: 'sequential_note_v1',
    });
    expect(semanticsForNoteMode('recent')).toEqual({
      purpose: 'browse',
      ordering: 'least_recently_viewed_v1',
    });
    expect(candidatePolicyVersionForOrdering('least_recently_viewed_v1')).toBe(
      'least_recently_viewed_v1'
    );
  });

  it('only lets opened/read_completed mutate the read-state projection', () => {
    expect(observationMutatesProgress('opened')).toBe(true);
    expect(observationMutatesProgress('read_completed')).toBe(true);
    expect(observationMutatesProgress('skipped')).toBe(false);
    expect(observationMutatesProgress('session_paused')).toBe(false);
  });
});
