import { describe, expect, it } from 'vitest';
import {
  chunkWordProgressIds,
  WORD_PROGRESS_FILTER_BATCH_SIZE,
} from '../word-study-service';

describe('word study progress query batching', () => {
  it('keeps a full candidate page below the PostgREST URL limit', () => {
    const ids = Array.from(
      { length: 500 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    );

    const batches = chunkWordProgressIds(ids);

    expect(batches).toHaveLength(5);
    expect(
      batches.every(batch => batch.length <= WORD_PROGRESS_FILTER_BATCH_SIZE)
    ).toBe(true);
    expect(batches.flat()).toEqual(ids);
  });

  it('does not create an empty trailing batch', () => {
    expect(chunkWordProgressIds([])).toEqual([]);
    expect(
      chunkWordProgressIds(
        Array.from({ length: WORD_PROGRESS_FILTER_BATCH_SIZE }, (_, index) =>
          String(index)
        )
      )
    ).toHaveLength(1);
  });
});
