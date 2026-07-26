import { describe, expect, it } from 'vitest';
import {
  orderNoteStudyCandidates,
  type NoteStudyCandidate,
} from '@/lib/note-study-ordering';

function candidate(
  item_id: string,
  notebook_order: number,
  sort_index: number,
  fields: { last_opened_at?: string | null; created_at?: string } = {}
): NoteStudyCandidate {
  return {
    item_id,
    notebook_id: `nb-${notebook_order}`,
    notebook_order,
    sort_index,
    last_opened_at: fields.last_opened_at ?? null,
    created_at: fields.created_at ?? '2026-01-01T00:00:00Z',
  };
}

describe('note-study ordering', () => {
  it('orders sequential_note_v1 by notebook, sort_index, then id', () => {
    const input = [
      candidate('b', 0, 2),
      candidate('a', 0, 1),
      candidate('c', 1, 1),
    ];
    const ordered = orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks sort_index ties on item_id', () => {
    const input = [candidate('z', 0, 5), candidate('a', 0, 5)];
    const ordered = orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['a', 'z']);
  });

  it('orders least_recently_viewed_v1 with longest-not-seen first', () => {
    const input = [
      candidate('recent', 0, 1, { last_opened_at: '2026-03-01T00:00:00Z' }),
      // Never viewed, old creation -> ranked as not-seen-since-created (first).
      candidate('never', 1, 2, {
        last_opened_at: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
      candidate('mid', 2, 3, { last_opened_at: '2026-02-01T00:00:00Z' }),
    ];
    const ordered = orderNoteStudyCandidates(input, 'least_recently_viewed_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['never', 'mid', 'recent']);
  });

  it('breaks last-viewed ties on item_id', () => {
    const input = [
      candidate('z', 0, 1, { last_opened_at: '2026-02-01T00:00:00Z' }),
      candidate('a', 0, 2, { last_opened_at: '2026-02-01T00:00:00Z' }),
    ];
    const ordered = orderNoteStudyCandidates(input, 'least_recently_viewed_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['a', 'z']);
  });

  it('does not mutate the input array', () => {
    const input = [candidate('b', 0, 2), candidate('a', 0, 1)];
    const snapshot = input.map(c => c.item_id);
    orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(input.map(c => c.item_id)).toEqual(snapshot);
  });
});
