import { describe, expect, it, vi } from 'vitest';
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  updateNotebook,
} from '@/lib/notebook-content-service';
import { NotebookToolError } from '@/lib/notebooks';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOTEBOOK_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const NOTE_ID = '55555555-5555-4555-8555-555555555555';

const ownerRow = {
  data: {
    id: NOTEBOOK_ID,
    user_id: USER_ID,
    subject_id: SUBJECT_ID,
    archived_at: null,
    revision: 3,
  },
  error: null,
};

// Chainable Supabase query stub. Builder methods return `this`; terminal
// methods (`maybeSingle`/`single`) and the awaited chain (`.limit()`) resolve
// to the preset { data, error } result.
function chain(result: any) {
  const q: any = {};
  for (const m of [
    'select',
    'eq',
    'is',
    'or',
    'order',
    'gt',
    'lt',
    'update',
    'insert',
    'upsert',
    'delete',
    'range',
    'in',
    'limit',
  ]) {
    q[m] = vi.fn(() => q);
  }
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: any, reject: any) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function makeClient(tableResults: Record<string, any[]>) {
  const counters: Record<string, number> = {};
  const created: Record<string, any[]> = {};
  const from = vi.fn((table: string) => {
    const idx = counters[table] ?? 0;
    counters[table] = idx + 1;
    const list = tableResults[table] || [];
    const result = list[Math.min(idx, list.length - 1)] ?? {
      data: null,
      error: null,
    };
    (created[table] ??= []).push(chain(result));
    return created[table][created[table].length - 1];
  });
  return { supabase: { from } as any, created };
}

describe('NotebookContentService', () => {
  it('rejects a cross-user notebook as not found', async () => {
    const { supabase } = makeClient({
      notebooks: [{ data: null, error: null }],
    });
    await expect(
      getNote(supabase, USER_ID, NOTEBOOK_ID, NOTE_ID)
    ).rejects.toThrow(/Notebook not found/);
  });

  it('returns a note with subject_id derived from its notebook', async () => {
    const { supabase } = makeClient({
      notebooks: [ownerRow],
      notebook_notes: [
        {
          data: {
            id: NOTE_ID,
            notebook_id: NOTEBOOK_ID,
            title: 'n',
            content: 'c',
            content_format: 'plain_text_v1',
            source: 'user',
            linked_problem_id: null,
            metadata: {},
            revision: 2,
            sort_index: 1,
            created_at: 't',
            updated_at: 't',
            archived_at: null,
          },
          error: null,
        },
      ],
    });
    const note = await getNote(supabase, USER_ID, NOTEBOOK_ID, NOTE_ID);
    expect(note.subject_id).toBe(SUBJECT_ID);
    expect(note.revision).toBe(2);
  });

  it('advances revision on a successful CAS update', async () => {
    const { supabase, created } = makeClient({
      notebooks: [
        ownerRow,
        {
          data: { ...ownerRow.data, title: 'renamed', revision: 4 },
          error: null,
        },
      ],
    });
    const result = await updateNotebook(supabase, USER_ID, NOTEBOOK_ID, {
      expected_revision: 3,
      title: 'renamed',
    });
    expect(result.revision).toBe(4);
    // The update targets the expected revision and writes expected+1.
    const updateQuery = created.notebooks[1];
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, title: 'renamed' })
    );
    expect(updateQuery.eq).toHaveBeenCalledWith('revision', 3);
  });

  it('raises a 409 revision_conflict when CAS misses but the row exists', async () => {
    const { supabase } = makeClient({
      notebooks: [
        ownerRow,
        { data: null, error: null }, // CAS update matched nothing
        { data: { revision: 9 }, error: null }, // row still exists at rev 9
      ],
    });
    await expect(
      updateNotebook(supabase, USER_ID, NOTEBOOK_ID, {
        expected_revision: 3,
        title: 'x',
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
  });

  it('rejects note content beyond the frozen byte/char limit', async () => {
    const { supabase } = makeClient({ notebooks: [ownerRow] });
    await expect(
      createNote(supabase, USER_ID, NOTEBOOK_ID, {
        title: 'ok',
        content: 'a'.repeat(4001),
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('replays an idempotent create on unique-violation', async () => {
    const existing = {
      id: NOTE_ID,
      notebook_id: NOTEBOOK_ID,
      title: 'first',
      content: 'c',
      content_format: 'plain_text_v1',
      source: 'user',
      linked_problem_id: null,
      metadata: {},
      revision: 1,
      sort_index: 1,
      created_at: 't',
      updated_at: 't',
      archived_at: null,
    };
    const { supabase } = makeClient({
      notebooks: [ownerRow],
      notebook_notes: [
        { data: null, error: { code: '23505' } }, // duplicate client_request_id
        { data: existing, error: null }, // replay lookup
      ],
    });
    const note = await createNote(supabase, USER_ID, NOTEBOOK_ID, {
      title: 'first',
      content: 'c',
      client_request_id: 'retry-token-1234',
    });
    expect(note.id).toBe(NOTE_ID);
  });

  it('applies title+content search as an ilike or-filter', async () => {
    const { supabase, created } = makeClient({
      notebooks: [ownerRow],
      notebook_notes: [{ data: [], error: null }],
    });
    await listNotes(supabase, USER_ID, NOTEBOOK_ID, { query: '函数' });
    const listQuery = created.notebook_notes[0];
    expect(listQuery.or).toHaveBeenCalledWith(
      expect.stringContaining('title.ilike.')
    );
    expect(listQuery.or).toHaveBeenCalledWith(
      expect.stringContaining('content.ilike.')
    );
  });

  it('reports has_more and a next_cursor using the extra fetched row', async () => {
    const makeRow = (id: string, sort_index: number) => ({
      id,
      notebook_id: NOTEBOOK_ID,
      title: id,
      content: 'c',
      content_format: 'plain_text_v1',
      source: 'user',
      linked_problem_id: null,
      metadata: {},
      revision: 1,
      sort_index,
      created_at: 't',
      updated_at: 't',
      archived_at: null,
    });
    const { supabase } = makeClient({
      notebooks: [ownerRow],
      notebook_notes: [
        {
          data: [makeRow('a', 1), makeRow('b', 2), makeRow('c', 3)],
          error: null,
        },
      ],
    });
    const result = await listNotes(supabase, USER_ID, NOTEBOOK_ID, {
      limit: 2,
    });
    expect(result.notes).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeTruthy();
    expect(result.order).toBe('stable');
  });

  it('raises a 409 conflict on a note CAS miss', async () => {
    const { supabase } = makeClient({
      notebooks: [ownerRow],
      notebook_notes: [
        { data: null, error: null }, // CAS update matched nothing
        { data: { revision: 5 }, error: null }, // note still exists
      ],
    });
    await expect(
      updateNote(supabase, USER_ID, NOTEBOOK_ID, NOTE_ID, {
        expected_revision: 2,
        content: 'new',
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
  });

  it('surfaces NotebookToolError instances for invalid list order', async () => {
    const { supabase } = makeClient({ notebooks: [ownerRow] });
    await expect(
      listNotes(supabase, USER_ID, NOTEBOOK_ID, {
        order: 'bogus' as any,
      })
    ).rejects.toBeInstanceOf(NotebookToolError);
  });
});
