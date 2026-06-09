import { describe, expect, it, vi } from 'vitest';
import {
  importWordEntriesToDeck,
  loadEsp32WordReview,
  loadEsp32WordSync,
  loadWordDecks,
  recordWordReview,
} from '@/lib/words';

const WORD_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const PROBLEM_SET_ID = '44444444-4444-4444-8444-444444444444';
const PROBLEM_ID = '55555555-5555-4555-8555-555555555555';
const SYSTEM_DECK_ID = '66666666-6666-4666-8666-666666666666';

const SYSTEM_DECK_ROW = {
  id: SYSTEM_DECK_ID,
  title: 'WQN 预设词库',
  description: '系统预设词库，当前为空',
  source: 'system',
  subject_id: null,
  subjects: null,
  language: 'en',
  target_language: 'zh-CN',
  lexicon_type: 'english_word',
  is_system: true,
  is_active: true,
  revision: 1,
  updated_at: '2026-06-08T00:00:00.000Z',
  word_entries: [{ count: 0 }],
  word_deck_ai_access: [],
};

function createAsyncQuery(result: {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}) {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((resolve, reject) =>
      Promise.resolve({
        data: result.data ?? null,
        error: result.error ?? null,
        count: result.count ?? null,
      }).then(resolve, reject)
    ),
  };
  return query;
}

function createSingleResult(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
}

function createInsertResult(data: unknown = null, error: unknown = null) {
  return {
    insert: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
}

function createUpdateResult(error: unknown = null) {
  return {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error }),
  };
}

function createWordReviewSupabase(outcome: 'known' | 'unknown') {
  return {
    from: vi.fn((table: string) => {
      if (table === 'word_entries') {
        return createSingleResult({
          id: WORD_ID,
          word: 'confirm',
          normalized_word: 'confirm',
          phonetic: '/kənˈfɜːm/',
          meaning: '确认',
          example: 'Please confirm your choice.',
          example_translation: '请确认你的选择。',
        });
      }
      if (table === 'word_progress') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          upsert: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              status: 'learning',
              due_at: '2026-06-01T00:00:00.000Z',
            },
            error: null,
          }),
        };
      }
      if (table === 'word_review_events') {
        return createInsertResult();
      }
      if (table === 'word_mistake_links') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          insert: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              problem_set_id: PROBLEM_SET_ID,
              problem_id: PROBLEM_ID,
            },
            error: null,
          }),
        };
      }
      if (table === 'subjects') {
        return createSingleResult(
          outcome === 'unknown' ? { id: SUBJECT_ID } : null
        );
      }
      if (table === 'problem_sets') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: PROBLEM_SET_ID },
            error: null,
          }),
          insert: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: PROBLEM_SET_ID },
            error: null,
          }),
        };
      }
      if (table === 'problems') {
        return {
          insert: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: PROBLEM_ID },
            error: null,
          }),
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      if (table === 'problem_set_problems') {
        return createInsertResult();
      }
      return createUpdateResult();
    }),
  } as any;
}

describe('Word review helpers', () => {
  it('lists the empty system word deck', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe('word_decks');
        return createAsyncQuery({ data: [SYSTEM_DECK_ROW] });
      }),
    } as any;

    const decks = await loadWordDecks(supabase, USER_ID);

    expect(decks).toEqual([
      expect.objectContaining({
        id: SYSTEM_DECK_ID,
        title: 'WQN 预设词库',
        description: '系统预设词库，当前为空',
        source: 'system',
        is_system: true,
        word_count: 0,
      }),
    ]);
  });

  it('syncs the empty system word deck to ESP32 without entries', async () => {
    let deckReads = 0;
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'word_decks') {
          deckReads += 1;
          return createAsyncQuery({
            data: deckReads === 1 ? [SYSTEM_DECK_ROW] : [{ id: SYSTEM_DECK_ID }],
          });
        }
        if (table === 'word_entries') {
          return createAsyncQuery({ data: [] });
        }
        if (table === 'word_progress') {
          return createAsyncQuery({ data: [] });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any;

    const result = await loadEsp32WordSync(supabase, USER_ID);

    expect(result.decks).toEqual([
      expect.objectContaining({
        id: SYSTEM_DECK_ID,
        title: 'WQN 预设词库',
        source: 'system',
        is_system: true,
        deleted: false,
      }),
    ]);
    expect(result.entries).toEqual([]);
  });

  it('returns a successful empty ESP32 review queue', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'word_entries') {
          return createAsyncQuery({ data: [] });
        }
        if (table === 'word_review_events') {
          return createAsyncQuery({ data: null, count: 0 });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any;

    const result = await loadEsp32WordReview(supabase, USER_ID, {
      mode: 'sequential',
      limit: 10,
    });

    expect(result).toMatchObject({
      mode: 'sequential',
      daily_target: 10,
      reviewed_today: 0,
      due_count: 0,
      words: [],
    });
  });

  it('returns the primary review action for known reviews', async () => {
    const result = await recordWordReview(
      { userId: USER_ID, supabase: createWordReviewSupabase('known') },
      { word_id: WORD_ID, outcome: 'known', mode: 'sequential' }
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'word_review_recorded',
      word_id: WORD_ID,
      word: 'confirm',
      outcome: 'known',
    });
  });

  it('returns review and wrong-word actions for unknown reviews', async () => {
    const result = await recordWordReview(
      { userId: USER_ID, supabase: createWordReviewSupabase('unknown') },
      { word_id: WORD_ID, outcome: 'unknown', mode: 'sequential' }
    );

    expect(result.actions.map(action => action.type)).toEqual([
      'word_review_recorded',
      'word_added_to_mistakes',
    ]);
    expect(result.actions[1]).toMatchObject({
      word_id: WORD_ID,
      problem_set_id: PROBLEM_SET_ID,
      problem_id: PROBLEM_ID,
    });
  });

  it('reuses the existing wrong-word link for unknown reviews', async () => {
    const from = vi.fn((table: string) => {
      if (table === 'word_entries') {
        return createSingleResult({
          id: WORD_ID,
          word: 'confirm',
          normalized_word: 'confirm',
          phonetic: '/confirm/',
          meaning: 'confirm',
        });
      }
      if (table === 'word_progress') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          upsert: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              status: 'learning',
              due_at: '2026-06-01T00:00:00.000Z',
            },
            error: null,
          }),
        };
      }
      if (table === 'word_review_events') {
        return createInsertResult();
      }
      if (table === 'word_mistake_links') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              problem_set_id: PROBLEM_SET_ID,
              problem_id: PROBLEM_ID,
            },
            error: null,
          }),
        };
      }
      if (table === 'problems') {
        const query: any = {
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: vi.fn((resolve, reject) =>
            Promise.resolve({ error: null }).then(resolve, reject)
          ),
        };
        return query;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const supabase = { from } as any;

    const result = await recordWordReview(
      { userId: USER_ID, supabase },
      { word_id: WORD_ID, outcome: 'unknown', mode: 'sequential' }
    );

    expect(result.extra_actions).toEqual([
      expect.objectContaining({
        type: 'word_added_to_mistakes',
        word_id: WORD_ID,
        problem_set_id: PROBLEM_SET_ID,
        problem_id: PROBLEM_ID,
      }),
    ]);
    expect(from).not.toHaveBeenCalledWith('subjects');
    expect(from).not.toHaveBeenCalledWith('problem_sets');
    expect(from).not.toHaveBeenCalledWith('problem_set_problems');
  });

  it('imports up to 4000 entries in 500-row chunks and dedupes by normalized word', async () => {
    const upsert = vi.fn((rows: unknown[]) => ({
      select: vi.fn().mockResolvedValue({
        data: rows.map((row: any, index) => ({
          id: `word-${index}`,
          deck_id: row.deck_id,
          word: row.word,
          normalized_word: row.normalized_word,
          phonetic: row.phonetic,
          meaning: row.meaning,
          example: row.example,
          example_translation: row.example_translation,
          part_of_speech: row.part_of_speech,
          tags: row.tags,
          sort_index: row.sort_index,
          revision: 1,
          updated_at: '2026-06-09T00:00:00.000Z',
        })),
        error: null,
      }),
    }));
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'word_decks') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: SYSTEM_DECK_ID },
              error: null,
            }),
          };
        }
        if (table === 'word_entries') {
          return { upsert };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any;
    const entries = Array.from({ length: 4000 }, (_, index) => ({
      word: `word-${index}`,
      meaning: `meaning-${index}`,
    }));
    entries[3999] = { word: 'WORD-1', meaning: 'updated meaning' };

    const result = await importWordEntriesToDeck(
      supabase,
      USER_ID,
      SYSTEM_DECK_ID,
      entries
    );

    expect(result.imported_count).toBe(3999);
    expect(upsert).toHaveBeenCalledTimes(8);
    const firstChunk = upsert.mock.calls[0]?.[0] as any[];
    expect(firstChunk[1]).toMatchObject({
      normalized_word: 'word-1',
      meaning: 'updated meaning',
    });
  });

  it('rejects imports above 4000 entries', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'word_decks') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: SYSTEM_DECK_ID },
              error: null,
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    } as any;

    await expect(
      importWordEntriesToDeck(
        supabase,
        USER_ID,
        SYSTEM_DECK_ID,
        Array.from({ length: 4001 }, (_, index) => ({
          word: `word-${index}`,
          meaning: `meaning-${index}`,
        }))
      )
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 413,
    });
  });
});
