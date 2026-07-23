// Note-study candidate ordering. Unlike word study there is no guided-random
// bucketing or seed dependence: both note orderings are deterministic
// projections of stable content fields.

export type NoteStudyOrderingKind =
  'sequential_note_v1' | 'recently_updated_v1';

export interface NoteStudyCandidate {
  item_id: string;
  notebook_id: string;
  /** Position of the note's notebook within the resolved scope order. */
  notebook_order: number;
  sort_index: number;
  updated_at: string;
}

function compareItemId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns a new array ordered by the given policy. Ties always break on
 * item_id so the ordering is total and reproducible for a fixed content set.
 */
export function orderNoteStudyCandidates(
  candidates: readonly NoteStudyCandidate[],
  ordering: NoteStudyOrderingKind
): NoteStudyCandidate[] {
  const arr = [...candidates];
  if (ordering === 'recently_updated_v1') {
    arr.sort((a, b) => {
      const ta = Date.parse(a.updated_at) || 0;
      const tb = Date.parse(b.updated_at) || 0;
      if (tb !== ta) return tb - ta; // most recently updated first
      return compareItemId(a.item_id, b.item_id);
    });
    return arr;
  }
  // sequential_note_v1: notebook order, then in-notebook sort_index, then id.
  arr.sort((a, b) => {
    if (a.notebook_order !== b.notebook_order) {
      return a.notebook_order - b.notebook_order;
    }
    if (a.sort_index !== b.sort_index) return a.sort_index - b.sort_index;
    return compareItemId(a.item_id, b.item_id);
  });
  return arr;
}
