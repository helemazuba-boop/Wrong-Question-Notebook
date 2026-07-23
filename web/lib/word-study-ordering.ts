import type { WordStudyOrdering } from './word-study-v1';

export type CandidateProgressStatus =
  'new' | 'learning' | 'review' | 'mastered';

export interface WordStudyCandidate {
  item_id: string;
  deck_id: string;
  deck_order: number;
  sort_index: number;
  normalized_word: string;
  status: CandidateProgressStatus;
  due_at: string | null;
}

// BigInt constructors keep this module compatible with the application's
// ES2017 emit target; BigInt literal syntax would require an ES2020 target.
const FNV_OFFSET_BASIS_64 = BigInt('0xcbf29ce484222325');
const FNV_PRIME_64 = BigInt('0x100000001b3');
const U64_MASK = BigInt('0xffffffffffffffff');

export function guidedRandomHash(seed: string, itemId: string): bigint {
  let hash = FNV_OFFSET_BASIS_64;
  const bytes = new TextEncoder().encode(`${seed}\0${itemId}`);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & U64_MASK;
  }
  return hash;
}

export function guidedRandomHashHex(seed: string, itemId: string): string {
  return guidedRandomHash(seed, itemId).toString(16).padStart(16, '0');
}

export function guidedRandomBucket(
  candidate: Pick<WordStudyCandidate, 'status' | 'due_at'>,
  nowMs: number
): number {
  if (candidate.status === 'mastered') return 4;
  if (candidate.status === 'new') return 2;

  const dueMs = candidate.due_at
    ? Date.parse(candidate.due_at)
    : Number.NEGATIVE_INFINITY;
  const due = !Number.isFinite(dueMs) || dueMs <= nowMs;
  if (!due) return 3;
  return candidate.status === 'learning' ? 0 : 1;
}

/**
 * The firmware orders text with std::string/strcmp, i.e. by UTF-8 bytes.
 * TextEncoder makes the cloud comparator explicit and avoids JavaScript's
 * UTF-16 code-unit ordering for supplementary-plane characters.
 */
export function compareUtf8Text(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }
  return leftBytes.length === rightBytes.length
    ? 0
    : leftBytes.length < rightBytes.length
      ? -1
      : 1;
}

export function orderWordStudyCandidates(
  candidates: readonly WordStudyCandidate[],
  ordering: WordStudyOrdering,
  seed: string,
  nowMs: number
): WordStudyCandidate[] {
  return [...candidates].sort((left, right) => {
    if (ordering === 'guided_random_v1') {
      const bucket =
        guidedRandomBucket(left, nowMs) - guidedRandomBucket(right, nowMs);
      if (bucket !== 0) return bucket;
      const leftHash = guidedRandomHash(seed, left.item_id);
      const rightHash = guidedRandomHash(seed, right.item_id);
      if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
      return compareUtf8Text(left.item_id, right.item_id);
    }

    if (ordering === 'lexicographic') {
      const word = compareUtf8Text(left.normalized_word, right.normalized_word);
      if (word !== 0) return word;
      return compareUtf8Text(left.item_id, right.item_id);
    }

    const deck = left.deck_order - right.deck_order;
    if (deck !== 0) return deck;
    const sortIndex = left.sort_index - right.sort_index;
    if (sortIndex !== 0) return sortIndex;
    const word = compareUtf8Text(left.normalized_word, right.normalized_word);
    if (word !== 0) return word;
    return compareUtf8Text(left.item_id, right.item_id);
  });
}
