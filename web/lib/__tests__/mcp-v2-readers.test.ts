import { describe, it, expect, vi } from 'vitest';
import { readV2, problemText, projectLegacy } from '@/lib/mcp/v2-readers';
import { convertMathTextToTipTapHtml } from '@/lib/math-to-tiptap';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
const { filtered, count, decks, notebooks, noteSession } = vi.hoisted(() => ({
  filtered: vi.fn(),
  count: vi.fn(),
  decks: vi.fn(),
  notebooks: vi.fn(),
  noteSession: vi.fn(),
}));
vi.mock('@/lib/review-utils', async () => ({
  ...(await vi.importActual('@/lib/review-utils')),
  getFilteredProblems: filtered,
  getFilteredProblemsCount: count,
}));
vi.mock('@/lib/words', async () => ({
  ...(await vi.importActual('@/lib/words')),
  listAuthorizedWordDecks: decks,
}));
vi.mock('@/lib/notebooks', async () => ({
  ...(await vi.importActual('@/lib/notebooks')),
  listAuthorizedNotebooks: notebooks,
}));
vi.mock('@/lib/note-study-web', async () => ({
  ...(await vi.importActual('@/lib/note-study-web')),
  loadWebNoteStudySession: noteSession,
}));
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function ctx(rows: any[]) {
  const b: any = {};
  for (const k of ['select', 'eq', 'is', 'order', 'range']) b[k] = () => b;
  b.maybeSingle = async () => ({ data: rows[0], error: null });
  b.then = (r: any) =>
    Promise.resolve({ data: rows, error: null, count: rows.length }).then(r);
  return {
    userId: uid,
    supabase: {
      from: () => b,
      storage: {
        from: () => ({
          createSignedUrls: async () => ({
            data: [{ signedUrl: 'https://wqn.example/signed-note-image' }],
            error: null,
          }),
        }),
      },
    },
  } as unknown as McpToolContext;
}
describe('v2 workflow reads', () => {
  it('keeps current Note image evidence in compact reading sessions', async () => {
    notebooks.mockResolvedValue({
      notebooks: [{ id, permissions: { can_read: true } }],
    });
    noteSession.mockResolvedValue({
      session_id: id,
      status: 'active',
      mode: 'sequential',
      candidate_count: 2,
      next_sequence: 0,
      notebook_ids: [id],
      result: {},
      current_item: {
        item_id: id,
        title: 'Note with figure',
        revision: 2,
        assets: [
          {
            path: `user/${uid}/note/image`,
            display_path: `user/${uid}/note/display`,
          },
        ],
      },
    });
    const data = await readV2(
      ctx([{ scope: { notebook_ids: [id] } }]),
      'get_note_reading_session',
      { session_id: id }
    );
    expect(data.current_item).toMatchObject({
      id,
      image_count: 1,
      images: [
        {
          path: `user/${uid}/note/image`,
          url: 'https://wqn.example/signed-note-image',
        },
      ],
    });
    expect(data.session.candidate_count).toBe(2);
    expect(data).not.toHaveProperty('items');
  });
  it('returns Word revision and all editable fields for the proposal workflow', async () => {
    decks.mockResolvedValue({
      decks: [
        {
          id,
          permissions: { can_read: true, can_create: true, can_update: false },
        },
      ],
    });
    const data = await readV2(
      ctx([
        {
          id,
          deck_id: id,
          word: 'apple',
          meaning: 'fruit',
          revision: 7,
          tags: ['food'],
          phonetic: 'phonetic',
          word_decks: {
            user_id: uid,
            is_system: false,
            is_active: true,
            archived_at: null,
          },
        },
      ]),
      'get_word_detail',
      { word_entry_id: id }
    );
    expect(data.item).toMatchObject({
      revision: 7,
      tags: ['food'],
      word_deck_id: id,
      phonetic: 'phonetic',
    });
  });
  it('projects recent note ids into a valid overview DTO', () => {
    const result = projectLegacy('get_note_reading_overview', {
      notebooks: [],
      recent: [
        {
          note_id: id,
          notebook_id: uid,
          note_title: 'Read note',
          state: 'completed',
          completed_count: 1,
        },
      ],
    });
    expect(result.recent_notes[0]).toMatchObject({
      id,
      title: 'Read note',
      read_state: { state: 'completed', completed_count: 1 },
    });
  });
  it('keeps TeX in readable text instead of losing empty math nodes', () => {
    expect(
      problemText(convertMathTextToTipTapHtml('解 $x^2 + 1$，并证明 $$y=2$$'))
    ).toContain('$x^2 + 1$');
    expect(
      problemText('<p>x</p><div data-type="block-math" data-latex="y=2"></div>')
    ).toContain('$$y=2$$');
  });
  it('counts smart sets by the same filter rather than their empty membership table', async () => {
    count.mockResolvedValue(12);
    const context = ctx([
      {
        id,
        title: 'Smart',
        name: 'Smart',
        subject_id: id,
        is_smart: true,
        filter_config: { statuses: ['wrong'] },
        problem_set_problems: [{ count: 0 }],
      },
    ]);
    const data = await readV2(context, 'list_problem_sets', {});
    expect(data.items[0].problem_count).toBe(12);
    expect(count).toHaveBeenCalledWith(
      context.supabase,
      uid,
      id,
      expect.objectContaining({ statuses: ['wrong'] })
    );
  });
  it('pages smart-set membership through the filter with consistent totals', async () => {
    count.mockResolvedValue(21);
    filtered.mockResolvedValue([{ id, title: 'matching', status: 'wrong' }]);
    const context = ctx([
      {
        id,
        subject_id: id,
        is_smart: true,
        filter_config: { statuses: ['wrong'], days_since_review: 7 },
      },
    ]);
    const data = await readV2(context, 'list_problem_set_problems', {
      problem_set_id: id,
      cursor: '20',
      limit: 10,
    });
    expect(data.total).toBe(21);
    expect(data.has_more).toBe(false);
    expect(data.items).toHaveLength(1);
    expect(filtered).toHaveBeenCalledWith(
      context.supabase,
      uid,
      id,
      expect.objectContaining({ days_since_review: 7 }),
      undefined,
      { offset: 20, limit: 10 }
    );
  });

  it('shares equivalent exact counts only inside one request', async () => {
    count.mockReset().mockResolvedValue(12);
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id,
      subject_id: id,
      is_smart: true,
      filter_config: {
        tag_ids: index % 2 ? [id, uid] : [uid, id, id],
        statuses: ['wrong'],
      },
    }));
    const context = ctx(rows);
    const first = await readV2(context, 'list_problem_sets', {});
    expect(first.items).toHaveLength(20);
    expect(first.items.every((item: any) => item.problem_count === 12)).toBe(
      true
    );
    expect(count).toHaveBeenCalledTimes(1);
    expect(rows[0].filter_config.tag_ids).toEqual([uid, id, id]);

    count.mockResolvedValue(13);
    const second = await readV2(context, 'list_problem_sets', {});
    expect(second.items[0].problem_count).toBe(13);
    expect(count).toHaveBeenCalledTimes(2);
    const other = { ...context, userId: id };
    await readV2(other, 'list_problem_sets', {});
    expect(count).toHaveBeenLastCalledWith(
      other.supabase,
      id,
      id,
      expect.any(Object)
    );
    expect(count).toHaveBeenCalledTimes(3);
  });

  it('bounds distinct count queries and retains page order and manual counts', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    count.mockReset().mockImplementation(async (_client, _user, subject) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return subject === id ? 4 : 8;
    });
    const result = readV2(
      ctx([
        { id, subject_id: id, is_smart: true },
        { id: uid, subject_id: uid, is_smart: true },
        {
          id,
          subject_id: id,
          is_smart: true,
          filter_config: { include_never_reviewed: false },
        },
        { id, is_smart: false, problem_set_problems: [{ count: 7 }] },
      ]),
      'list_problem_sets',
      {}
    );
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2]();
    releases[0]();
    const page = await result;
    expect(peak).toBe(2);
    expect(page.items.map((item: any) => item.problem_count)).toEqual([
      4, 8, 4, 7,
    ]);
    expect(page.total).toBe(4);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it('does not conflate different subjects or any filter dimension', async () => {
    count.mockReset().mockResolvedValue(0);
    const filters = [
      {},
      { tag_ids: [id] },
      { statuses: ['wrong'] },
      { problem_types: ['choice'] },
      { days_since_review: 7 },
      { include_never_reviewed: false },
    ];
    const rows = filters.map(filter_config => ({
      id,
      subject_id: id,
      is_smart: true,
      filter_config,
    }));
    await readV2(
      ctx([...rows, { id, subject_id: uid, is_smart: true }]),
      'list_problem_sets',
      {}
    );
    expect(count).toHaveBeenCalledTimes(7);
  });
});
