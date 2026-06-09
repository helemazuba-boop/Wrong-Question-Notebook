import { describe, expect, it, vi } from 'vitest';
import { loadNotebookShelf } from '@/lib/notebooks';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';

function createQuery(data: unknown[]) {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    then: vi.fn((resolve, reject) =>
      Promise.resolve({ data, error: null }).then(resolve, reject)
    ),
  };
  return query;
}

describe('Notebook shelf helpers', () => {
  it('includes word decks as shelf content without loading todos', async () => {
    const from = vi.fn((table: string) => {
      if (table === 'problem_sets') {
        return createQuery([
          {
            id: 'problem-set-1',
            name: '函数错题本',
            description: null,
            subject_id: SUBJECT_ID,
            updated_at: '2026-06-09T00:00:00.000Z',
            subjects: { name: '数学' },
            problem_set_problems: [{ count: 3 }],
          },
        ]);
      }
      if (table === 'notebooks') {
        return createQuery([]);
      }
      if (table === 'word_decks') {
        return createQuery([
          {
            id: 'word-deck-1',
            title: '高中 3500',
            description: '英语词库',
            source: 'user',
            subject_id: SUBJECT_ID,
            subjects: { name: '英语' },
            language: 'en',
            target_language: 'zh-CN',
            lexicon_type: 'english_word',
            is_system: false,
            updated_at: '2026-06-09T01:00:00.000Z',
            word_entries: [{ count: 4000 }],
          },
        ]);
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const items = await loadNotebookShelf({ from } as any, USER_ID);

    expect(from).toHaveBeenCalledWith('problem_sets');
    expect(from).toHaveBeenCalledWith('notebooks');
    expect(from).toHaveBeenCalledWith('word_decks');
    expect(from).not.toHaveBeenCalledWith('todos');
    expect(items[0]).toMatchObject({
      id: 'word-deck-1',
      type: 'word_deck',
      title: '高中 3500',
      subject_id: SUBJECT_ID,
      subject_name: '英语',
      count: 4000,
      metadata: {
        lexicon_type: 'english_word',
        is_system: false,
      },
    });
  });
});
