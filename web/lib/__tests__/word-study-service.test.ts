import { describe, expect, it } from 'vitest';
import {
  isWordStudySessionSnapshotReadable,
  mergeWordStudyCandidatePage,
} from '../word-study-service';
import type { WordStudyCandidate } from '../word-study-ordering';

const candidate = (
  item_id: string,
  deck_order: number,
  normalized_word: string,
  status: WordStudyCandidate['status'] = 'new'
): WordStudyCandidate => ({
  item_id,
  deck_id: String(deck_order),
  deck_order,
  sort_index: 0,
  normalized_word,
  status,
  due_at: null,
});

describe('word study bounded candidate merge', () => {
  it('lets a later deck win when its candidate is globally better', () => {
    const result = mergeWordStudyCandidatePage(
      [candidate('first', 0, 'zulu')],
      [candidate('later', 1, 'alpha')],
      'lexicographic',
      'seed',
      0,
      1
    );
    expect(result.map(item => item.item_id)).toEqual(['later']);
  });

  it('preserves sequential deck priority by policy', () => {
    const result = mergeWordStudyCandidatePage(
      [candidate('first', 0, 'zulu')],
      [candidate('later', 1, 'alpha')],
      'sequential',
      'seed',
      0,
      1
    );
    expect(result.map(item => item.item_id)).toEqual(['first']);
  });
});

describe('word study session snapshot paging', () => {
  const now = Date.parse('2026-07-22T00:00:00.000Z');

  it('keeps an unexpired abandoned session readable', () => {
    expect(
      isWordStudySessionSnapshotReadable(
        'abandoned',
        '2026-07-23T00:00:00.000Z',
        now
      )
    ).toBe(true);
  });

  it('rejects completed or expired snapshots', () => {
    expect(
      isWordStudySessionSnapshotReadable(
        'completed',
        '2026-07-23T00:00:00.000Z',
        now
      )
    ).toBe(false);
    expect(
      isWordStudySessionSnapshotReadable(
        'abandoned',
        '2026-07-21T00:00:00.000Z',
        now
      )
    ).toBe(false);
  });
});
