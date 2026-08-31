import { describe, expect, it } from 'vitest';
import {
  AcceptProblemIngestionCandidatesSchema,
  ProblemIngestionCandidateAssetsSchema,
  UpdateProblemIngestionCandidateSchema,
} from '@/lib/problem-ingestion-workspace-contract';
import {
  duplicateProblemIngestionQuestionIds,
  type ProblemIngestionDocument,
} from '@/lib/problem-ingestion';

describe('Problem ingestion workspace contract', () => {
  it('preserves explicit candidate image order', () => {
    const assets = [
      { path: 'first', name: 'first.png', part_id: null },
      { path: 'second', name: 'second.png', part_id: 'part-1-1' },
    ];
    expect(ProblemIngestionCandidateAssetsSchema.parse(assets)).toEqual(assets);
  });

  it('rejects duplicate paths and more than 20 images per role', () => {
    const duplicate = { path: 'same', name: 'image.png', part_id: null };
    expect(
      ProblemIngestionCandidateAssetsSchema.safeParse([duplicate, duplicate])
        .success
    ).toBe(false);
    expect(
      ProblemIngestionCandidateAssetsSchema.safeParse(
        Array.from({ length: 21 }, (_, index) => ({
          path: `image-${index}`,
          name: `${index}.png`,
          part_id: null,
        }))
      ).success
    ).toBe(false);
  });

  it('accepts only unique batches of at most 20 questions', () => {
    expect(
      AcceptProblemIngestionCandidatesSchema.safeParse({
        question_ids: Array.from({ length: 20 }, (_, index) => `q-${index}`),
      }).success
    ).toBe(true);
    expect(
      AcceptProblemIngestionCandidatesSchema.safeParse({
        question_ids: Array.from({ length: 21 }, (_, index) => `q-${index}`),
      }).success
    ).toBe(false);
    expect(
      AcceptProblemIngestionCandidatesSchema.safeParse({
        question_ids: ['q-1', 'q-1'],
      }).success
    ).toBe(false);
  });

  it('does not expose accepted as a client-controlled status', () => {
    expect(
      UpdateProblemIngestionCandidateSchema.safeParse({ status: 'skipped' })
        .success
    ).toBe(true);
    expect(
      UpdateProblemIngestionCandidateSchema.safeParse({ status: 'accepted' })
        .success
    ).toBe(false);
  });

  it('detects duplicate question IDs before persistence', () => {
    expect(
      duplicateProblemIngestionQuestionIds({
        questions: [
          { question_id: 'q-1' },
          { question_id: 'q-2' },
          { question_id: 'q-1' },
        ],
      } as ProblemIngestionDocument)
    ).toEqual(['q-1']);
  });
});
