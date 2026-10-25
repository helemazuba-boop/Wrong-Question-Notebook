import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, TEST_USER, SUBJECT_ID } from '../test/supabase-query';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  notes: vi.fn(),
  summaries: vi.fn(),
  recent: vi.fn(),
  resumable: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: mocks.from }),
}));
vi.mock('@/lib/notebook-content-service', () => ({ listNotes: mocks.notes }));
vi.mock('@/lib/note-study-web', () => ({
  loadNotebookReadSummaries: mocks.summaries,
  loadRecentNoteReads: mocks.recent,
  loadResumableWebNoteStudySessions: mocks.resumable,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => () => 'Notebook',
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/app/[locale]/(app)/notebooks/[id]/notebook-page-client', () => ({
  default: () => null,
}));
import NotebookPage, {
  generateMetadata,
} from '@/app/[locale]/(app)/notebooks/[id]/page';

const id = '11111111-1111-4111-8111-111111111111';
const params = () => ({ params: Promise.resolve({ id }) });
const notebook = {
  id,
  title: 'Owned notebook',
  description: 'Description',
  subject_id: SUBJECT_ID,
  updated_at: '2026-10-25T00:00:00Z',
  revision: 2,
  subjects: { name: 'Math' },
  notebook_ai_access: [
    { can_read: true, can_create: false, can_update: false },
  ],
};
const client = { from: mocks.from };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ user: TEST_USER, supabase: client });
  mocks.from.mockImplementation(() => queryResult(notebook));
  mocks.notes.mockResolvedValue({
    notes: [{ id: 'note', title: 'First note' }],
  });
  mocks.summaries.mockResolvedValue({ [id]: { completed_count: 1 } });
  mocks.recent.mockResolvedValue([{ note_id: 'note' }]);
  mocks.resumable.mockResolvedValue([{ session_id: 'session' }]);
});

function expectNoReadingLoads() {
  for (const load of [
    mocks.notes,
    mocks.summaries,
    mocks.recent,
    mocks.resumable,
  ])
    expect(load).not.toHaveBeenCalled();
}

describe('notebook page metadata', () => {
  it('uses a scoped title-only query without loading notes or reading state', async () => {
    const query = queryResult({ title: notebook.title });
    mocks.from.mockReturnValue(query);
    expect(await generateMetadata(params())).toEqual({ title: notebook.title });
    console.info('METADATA_LOAD_OPERATIONS', {
      notebookQueries: mocks.from.mock.calls.length,
      readingServiceCalls: [
        mocks.notes,
        mocks.summaries,
        mocks.recent,
        mocks.resumable,
      ].reduce((total, load) => total + load.mock.calls.length, 0),
    });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('notebooks');
    expect(query.select).toHaveBeenCalledExactlyOnceWith('title');
    expect(query.eq).toHaveBeenCalledWith('id', id);
    expect(query.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(query.is).toHaveBeenCalledExactlyOnceWith('archived_at', null);
    expectNoReadingLoads();
  });

  it('can produce metadata when unrelated reading services are unavailable', async () => {
    mocks.notes.mockRejectedValue(new Error('note content unavailable'));
    expect(await generateMetadata(params())).toEqual({ title: notebook.title });
    expectNoReadingLoads();
  });

  it('does not query or reveal a title for an unauthenticated request', async () => {
    mocks.requireUser.mockResolvedValue({ user: null, supabase: client });
    expect(await generateMetadata(params())).toEqual({ title: 'Notebook' });
    expect(mocks.from).not.toHaveBeenCalled();
    expectNoReadingLoads();
  });

  it.each([
    [null, null],
    [{ title: 'Do not reveal partial data' }, { message: 'query failed' }],
  ])(
    'returns the generic title for missing/archived or failed reads',
    async (data, error) => {
      mocks.from.mockReturnValue(queryResult(data, error));
      expect(await generateMetadata(params())).toEqual({ title: 'Notebook' });
      expectNoReadingLoads();
    }
  );

  it('continues to prepare complete page data once using the authenticated client', async () => {
    const result = await NotebookPage(params());
    expect(result.props.notebook).toMatchObject({
      id,
      title: notebook.title,
      revision: 2,
      ai_access: { can_read: true, can_create: false, can_update: false },
    });
    expect(result.props.initialNotes).toEqual([
      { id: 'note', title: 'First note' },
    ]);
    expect(result.props.initialRecentReads).toEqual([{ note_id: 'note' }]);
    expect(result.props.initialResumableSession).toEqual({
      session_id: 'session',
    });
    expect(mocks.notes).toHaveBeenCalledExactlyOnceWith(
      client,
      TEST_USER.id,
      id,
      {
        order: 'stable',
        limit: 50,
      }
    );
    for (const load of [mocks.summaries, mocks.recent, mocks.resumable])
      expect(load).toHaveBeenCalledOnce();
  });

  it('keeps missing notebook pages at notFound without loading reading data', async () => {
    mocks.from.mockReturnValue(queryResult(null));
    await expect(NotebookPage(params())).rejects.toThrow('notFound');
    expectNoReadingLoads();
  });
});
