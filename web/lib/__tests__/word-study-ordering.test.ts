import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
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
