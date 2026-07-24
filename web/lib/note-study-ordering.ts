// Note-study candidate ordering. Unlike word study there is no guided-random
// bucketing or seed dependence: both note orderings are deterministic
// projections of stable content fields.

export type NoteStudyOrderingKind =
  'sequential_note_v1' | 'least_recently_viewed_v1';

export interface NoteStudyCandidate {
  item_id: string;
  notebook_id: string;
  /** Position of the note's notebook within the resolved scope order. */
  notebook_order: number;
  sort_index: number;
  /** Read-state pin: when the note was last opened, or null if never. */
  last_opened_at: string | null;
  /** Creation time, used as the fallback ordering key for never-viewed notes. */
  created_at: string;
}

function compareItemId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// COALESCE(last_opened_at, created_at) as epoch ms. Never-viewed notes fall
// back to creation time so they are ranked as "not seen since created".
function lastViewedKey(candidate: NoteStudyCandidate): number {
  const source = candidate.last_opened_at || candidate.created_at || '';
  return Date.parse(source) || 0;
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
  if (ordering === 'least_recently_viewed_v1') {
    // Recommendation surfaces the longest-not-seen notes first (ascending on
    // last-viewed / creation time).
    arr.sort((a, b) => {
      const ka = lastViewedKey(a);
      const kb = lastViewedKey(b);
      if (ka !== kb) return ka - kb;
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
