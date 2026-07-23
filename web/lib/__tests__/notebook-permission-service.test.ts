import { describe, expect, it, vi } from 'vitest';
import {
  getAiAccess,
  requireAiCreate,
  requireAiRead,
  requireAiUpdate,
  requireLinkedProblemOwner,
  updateAiAccess,
} from '@/lib/notebook-permission-service';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOTEBOOK_ID = '44444444-4444-4444-8444-444444444444';
const PROBLEM_ID = '66666666-6666-4666-8666-666666666666';

function chain(result: any) {
  const q: any = {};
  for (const m of ['select', 'eq', 'is', 'upsert']) q[m] = vi.fn(() => q);
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.single = vi.fn(() => Promise.resolve(result));
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

describe('NotebookPermissionService — AI access matrix', () => {
  it('throws when the corresponding capability is not granted', () => {
    const denied = { can_read: false, can_create: false, can_update: false };
    expect(() => requireAiRead(denied)).toThrow(/no permission to read/);
    expect(() => requireAiCreate(denied)).toThrow(/no permission to write/);
    expect(() => requireAiUpdate(denied)).toThrow(/no permission to update/);
  });

  it('passes when the capability is granted', () => {
    expect(() =>
      requireAiRead({ can_read: true, can_create: false, can_update: false })
    ).not.toThrow();
    expect(() =>
      requireAiCreate({ can_read: false, can_create: true, can_update: false })
    ).not.toThrow();
  });

  it('defaults every capability to false when no grant row exists', async () => {
    const { supabase } = makeClient({
      notebook_ai_access: [{ data: null, error: null }],
    });
    const access = await getAiAccess(supabase, USER_ID, NOTEBOOK_ID);
    expect(access).toEqual({
      can_read: false,
      can_create: false,
      can_update: false,
    });
  });

  it('forces can_update to false even when the caller requests it', async () => {
    const { supabase, created } = makeClient({
      notebooks: [
        {
          data: {
            id: NOTEBOOK_ID,
            user_id: USER_ID,
            subject_id: 's',
            archived_at: null,
            revision: 1,
          },
          error: null,
        },
      ],
      notebook_ai_access: [
        {
          data: { can_read: true, can_create: true, can_update: false },
          error: null,
        },
      ],
    });
    const access = await updateAiAccess(supabase, USER_ID, NOTEBOOK_ID, {
      can_read: true,
      can_create: true,
      can_update: true,
    });
    expect(access.can_update).toBe(false);
    // The persisted row is written with can_update: false regardless of input.
    expect(created.notebook_ai_access[0].upsert).toHaveBeenCalledWith(
      expect.objectContaining({ can_update: false }),
      expect.anything()
    );
  });

  it('rejects a linked problem owned by another user', async () => {
    const { supabase } = makeClient({
      problems: [{ data: null, error: null }],
    });
    await expect(
      requireLinkedProblemOwner(supabase, USER_ID, PROBLEM_ID)
    ).rejects.toMatchObject({ code: 'problem_not_found', status: 404 });
  });
});
