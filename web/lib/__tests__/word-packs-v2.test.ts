import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { WordToolError } from '../words';
import {
  WORD_PACK_MAGIC,
  WORD_PACK_MAX_LINE_BYTES,
  buildDeterministicWordPackBytes,
} from '../word-packs';

const deck = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Stable words',
  description: null,
  source: 'manual',
  language: 'en',
  target_language: 'zh-CN',
  subject_id: null,
  lexicon_type: 'english_word',
  is_system: false,
  revision: 7,
  created_at: '2026-07-20T00:00:00.000Z',
  updated_at: '2026-07-20T12:00:00.000Z',
};

const entry = {
  id: '22222222-2222-4222-8222-222222222222',
  deck_id: deck.id,
  word: 'baseline',
  normalized_word: 'baseline',
  phonetic: '/ˈbeɪslaɪn/',
  meaning: '基线',
  example: 'The behavior has a stable baseline.',
  example_translation: '这一行为有稳定的基线。',
  part_of_speech: 'noun',
  tags: ['architecture'],
  sort_index: 3,
  revision: 2,
  updated_at: '2026-07-20T12:00:00.000Z',
};

describe('word pack v2', () => {
  it('emits byte-identical content for the same content revision', () => {
    const first = buildDeterministicWordPackBytes(deck, [entry]);
    const second = buildDeterministicWordPackBytes(
      { ...deck, updated_at: '2099-01-01T00:00:00.000Z' },
      [{ ...entry, updated_at: '2099-01-01T00:00:00.000Z' }]
    );

    expect(second.equals(first)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex')
    );
    expect(first.toString('utf8').split('\n')[0]).toBe(WORD_PACK_MAGIC);
    expect(first.toString('utf8')).not.toContain('generated_at');
    expect(first.toString('utf8')).not.toContain('updated_at');
  });

  it('rejects a JSONL record beyond the device line bound', () => {
    expect(() =>
      buildDeterministicWordPackBytes(deck, [
        { ...entry, meaning: 'x'.repeat(WORD_PACK_MAX_LINE_BYTES) },
      ])
    ).toThrowError(WordToolError);
  });
});
