import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  compareUtf8Text,
  guidedRandomHashHex,
  orderWordStudyCandidates,
  type WordStudyCandidate,
} from '../word-study-ordering';

interface OrderingFixture {
  seed: string;
  now: string;
  candidates: Array<Omit<WordStudyCandidate, 'deck_id'>>;
  expected_hashes: Record<string, string>;
  expected_sequential: string[];
  expected_guided_random: string[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'contracts/word-study-v1/fixtures/valid/candidate-order.json'
    ),
    'utf8'
  )
) as OrderingFixture;

const candidates: WordStudyCandidate[] = fixture.candidates.map(candidate => ({
  ...candidate,
  deck_id:
    candidate.deck_order === 0
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222',
}));

describe('word study ordering', () => {
  it.each(['guided_random_v1', 'pure_random_v1', 'mistake_words_v1'] as const)(
    'evaluates each %s rank once per sort and isolates seeds and calls',
    ordering => {
      const input = Array.from({ length: 128 }, (_, index) => ({
        ...candidates[0],
        item_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        status: 'new' as const,
      }));
      const expected = (seed: string) =>
        input
          .map(candidate => ({
            id: candidate.item_id,
            rank: guidedRandomHashHex(seed, candidate.item_id),
          }))
          .sort((left, right) => (left.rank < right.rank ? -1 : 1))
          .map(row => row.id);
      const firstExpected = expected('first-seed');
      const secondExpected = expected('second-seed');
      const encode = TextEncoder.prototype.encode;
      const evaluated: string[] = [];
      const spy = vi
        .spyOn(TextEncoder.prototype, 'encode')
        .mockImplementation(function (this: TextEncoder, value) {
          if (typeof value === 'string' && value.includes('\0'))
            evaluated.push(value);
          return encode.call(this, value);
        });
      try {
        for (const [seed, expectedIds] of [
          ['first-seed', firstExpected],
          ['first-seed', firstExpected],
          ['second-seed', secondExpected],
        ] as const) {
          const start = evaluated.length;
          const sorted = orderWordStudyCandidates(
            input,
            ordering,
            seed,
            Date.parse(fixture.now)
          );
          expect(sorted.map(row => row.item_id)).toEqual(expectedIds);
          expect(evaluated.slice(start)).toHaveLength(input.length);
          expect(new Set(evaluated.slice(start)).size).toBe(input.length);
        }
        expect(firstExpected).not.toEqual(secondExpected);
        expect(input[0].item_id).toBe('00000000-0000-4000-8000-000000000001');
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('matches firmware UTF-8 byte ordering for supplementary characters', () => {
    const bmpPrivateUse = '\uE000';
    const supplementary = '\u{10000}';
    expect(compareUtf8Text(bmpPrivateUse, supplementary)).toBeLessThan(0);
    expect(
      orderWordStudyCandidates(
        [
          {
            ...candidates[0],
            item_id: 'bmp',
            normalized_word: bmpPrivateUse,
          },
          {
            ...candidates[1],
            item_id: 'supplementary',
            normalized_word: supplementary,
          },
        ],
        'lexicographic',
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id)
    ).toEqual(['bmp', 'supplementary']);
  });

  it('matches the language-neutral FNV-1a-64 fixture', () => {
    for (const candidate of candidates) {
      expect(guidedRandomHashHex(fixture.seed, candidate.item_id)).toBe(
        fixture.expected_hashes[candidate.item_id]
      );
    }
  });

  it('preserves deck import order in sequential mode', () => {
    expect(
      orderWordStudyCandidates(
        candidates,
        'sequential',
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id)
    ).toEqual(fixture.expected_sequential);
  });

  it('orders the review queue as a list: learning, then due review by due_at', () => {
    expect(
      orderWordStudyCandidates(
        candidates,
        'due_queue_v1',
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id)
    ).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000007',
      '00000000-0000-4000-8000-000000000005',
    ]);
  });

  it('walks the deck order for new-word intake', () => {
    expect(
      orderWordStudyCandidates(
        candidates,
        'new_intake_v1',
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id)
    ).toEqual(fixture.expected_sequential);
  });

  it('shuffles pure random and mistakes stably by the pinned hashes', () => {
    const expected = [...candidates]
      .sort((left, right) => {
        const leftHash = fixture.expected_hashes[left.item_id];
        const rightHash = fixture.expected_hashes[right.item_id];
        if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
        return left.item_id < right.item_id ? -1 : 1;
      })
      .map(candidate => candidate.item_id);

    for (const ordering of ['pure_random_v1', 'mistake_words_v1'] as const) {
      const forward = orderWordStudyCandidates(
        candidates,
        ordering,
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id);
      const reversed = orderWordStudyCandidates(
        [...candidates].reverse(),
        ordering,
        fixture.seed,
        Date.parse(fixture.now)
      ).map(candidate => candidate.item_id);

      expect(forward).toEqual(expected);
      expect(reversed).toEqual(expected);
    }
  });

  it('produces the stable guided-random order without exposing reasons', () => {
    const first = orderWordStudyCandidates(
      candidates,
      'guided_random_v1',
      fixture.seed,
      Date.parse(fixture.now)
    ).map(candidate => candidate.item_id);
    const second = orderWordStudyCandidates(
      [...candidates].reverse(),
      'guided_random_v1',
      fixture.seed,
      Date.parse(fixture.now)
    ).map(candidate => candidate.item_id);

    expect(first).toEqual(fixture.expected_guided_random);
    expect(second).toEqual(first);
  });
});
