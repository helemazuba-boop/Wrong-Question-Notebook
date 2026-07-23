import { describe, expect, it } from 'vitest';
import {
  orderNoteStudyCandidates,
  type NoteStudyCandidate,
} from '@/lib/note-study-ordering';

function candidate(
  item_id: string,
  notebook_order: number,
  sort_index: number,
  updated_at: string
): NoteStudyCandidate {
  return {
    item_id,
    notebook_id: `nb-${notebook_order}`,
    notebook_order,
    sort_index,
    updated_at,
  };
}

describe('note-study ordering', () => {
  it('orders sequential_note_v1 by notebook, sort_index, then id', () => {
    const input = [
      candidate('b', 0, 2, '2026-01-02T00:00:00Z'),
      candidate('a', 0, 1, '2026-01-03T00:00:00Z'),
      candidate('c', 1, 1, '2026-01-01T00:00:00Z'),
    ];
    const ordered = orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks sort_index ties on item_id', () => {
    const input = [
      candidate('z', 0, 5, '2026-01-01T00:00:00Z'),
      candidate('a', 0, 5, '2026-01-01T00:00:00Z'),
    ];
    const ordered = orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['a', 'z']);
  });

  it('orders recently_updated_v1 by updated_at descending, then id', () => {
    const input = [
      candidate('old', 0, 1, '2026-01-01T00:00:00Z'),
      candidate('new', 3, 9, '2026-03-01T00:00:00Z'),
      candidate('mid', 1, 5, '2026-02-01T00:00:00Z'),
    ];
    const ordered = orderNoteStudyCandidates(input, 'recently_updated_v1');
    expect(ordered.map(c => c.item_id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the input array', () => {
    const input = [candidate('b', 0, 2, 't'), candidate('a', 0, 1, 't')];
    const snapshot = input.map(c => c.item_id);
    orderNoteStudyCandidates(input, 'sequential_note_v1');
    expect(input.map(c => c.item_id)).toEqual(snapshot);
  });
});
