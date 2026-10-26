import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { createWordStudySession } from '../word-study-service';
import { createWordStudySessionRequestSchema } from '../word-study-v1';

const packs = vi.hoisted(() => ({
  ensure: vi.fn(),
  visible: vi.fn(),
}));
vi.mock('../word-packs', () => ({
  ensureWordPackForDeck: packs.ensure,
  loadVisibleWordPackDecks: packs.visible,
  loadVisibleWordPackDecksByIds: packs.visible,
}));

const ids = Array.from(
  { length: 4 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
);
const decks = ids.map(id => ({ id, revision: 2 }));
function input(deckIds = ids) {
  return createWordStudySessionRequestSchema.parse({
    request_id: 'req_word_prepare_001',
    boot_id: 'boot_word_prepare_001',
    firmware_version: 'test',
    capabilities: ['word.study.v1'],
    domain: 'word',
    mode: 'sequential',
    scope: { deck_ids: deckIds, include_mastered: false },
    optional_count: 20,
    seed: 'fixed_seed',
  });
}
function client() {
  const from = vi.fn((table: string) => {
    const query: Record<string, any> = {};
    for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range'])
      query[name] = () => query;
    query.maybeSingle = async () => ({
      data: table === 'word_change_log' ? { sequence: 0 } : null,
      error: null,
    });
    query.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return query;
  });
  const rpc = vi.fn(async (_name: string, args: Record<string, any>) => ({
    data: {
      id: ids[0],
      domain: args.p_domain,
      mode: args.p_mode,
      purpose: args.p_purpose,
      ordering: args.p_ordering,
      scope: args.p_scope,
      optional_count: args.p_optional_count,
      seed: args.p_seed,
      snapshot: args.p_snapshot,
      candidate_items: args.p_candidate_items,
      cursor: args.p_cursor,
      has_more: args.p_has_more,
      next_sequence: 0,
      progress_revision: args.p_progress_revision,
    },
    error: null,
  }));
  return {
    supabase: { from, rpc } as unknown as SupabaseClient<Database>,
    from,
    rpc,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  packs.visible.mockResolvedValue(decks);
});

describe('word session pack preparation', () => {
  it('finishes four independent 100ms pack operations in two waves', async () => {
    vi.useFakeTimers();
    try {
      packs.ensure.mockImplementation(async (_client, deck) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { revision: deck.revision, sha256: 'a'.repeat(64) };
      });
      const { supabase } = client();
      const startedAt = Date.now();
      let elapsedMs = 0;
      const result = createWordStudySession(
        supabase,
        ids[0],
        null,
        input()
      ).then(session => {
        elapsedMs = Date.now() - startedAt;
        return session;
      });
      await vi.advanceTimersByTimeAsync(400);
      await result;
      console.info('PACK_PREPARATION_SIMULATION', {
        decks: 4,
        perPackMs: 100,
        elapsedMs,
      });
      expect(elapsedMs).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepares two packs at most and preserves caller deck/snapshot order', async () => {
    const gates = ids.map(() => deferred<void>());
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    packs.ensure.mockImplementation(async (_client, deck) => {
      active++;
      peak = Math.max(peak, active);
      started.push(deck.id);
      await gates[ids.indexOf(deck.id)].promise;
      active--;
      return { revision: deck.revision, sha256: 'a'.repeat(64) };
    });
    const { supabase, rpc } = client();
    const orderedIds = [ids[2], ids[0], ids[3], ids[1]];
    const result = createWordStudySession(
      supabase,
      ids[0],
      null,
      input(orderedIds)
    );
    await vi.waitFor(() => expect(started).toEqual(orderedIds.slice(0, 2)));
    gates[0].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    gates[3].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    gates[1].resolve();
    gates[2].resolve();
    const session = await result;
    expect(peak).toBe(2);
    expect(session.scope.deck_ids).toEqual(orderedIds);
    expect(session.snapshot.map(pack => pack.deck_id)).toEqual(orderedIds);
    expect(session.snapshot.every(pack => pack.content_revision === 2)).toBe(
      true
    );
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('settles started pack work before failure without scanning candidates or creating a session', async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const failure = new Error('pack revision changed');
    packs.ensure.mockImplementation(async (_client, deck) => {
      await gates[ids.indexOf(deck.id)].promise;
      return { revision: 2, sha256: 'a'.repeat(64) };
    });
    const { supabase, from, rpc } = client();
    const settled = vi.fn();
    const result = createWordStudySession(supabase, ids[0], null, input());
    void result.then(settled, settled);
    await vi.waitFor(() => expect(packs.ensure).toHaveBeenCalledTimes(2));
    gates[0].reject(failure);
    await gates[0].promise.catch(() => undefined);
    expect(settled).not.toHaveBeenCalled();
    gates[1].resolve();
    await expect(result).rejects.toBe(failure);
    expect(packs.ensure).toHaveBeenCalledTimes(2);
    expect(from.mock.calls.map(([table]) => table)).toEqual(['study_sessions']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects invisible scope before starting any pack work', async () => {
    packs.visible.mockResolvedValue(decks.slice(0, 1));
    const { supabase, rpc } = client();
    await expect(
      createWordStudySession(supabase, ids[0], null, input())
    ).rejects.toMatchObject({ code: 'WORD_SCOPE_NOT_VISIBLE' });
    expect(packs.ensure).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
