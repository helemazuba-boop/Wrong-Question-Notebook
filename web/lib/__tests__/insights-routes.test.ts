import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, request, TEST_USER } from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  after: vi.fn(),
  backfill: vi.fn(),
  generate: vi.fn(),
  createServiceClient: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.requireUser,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
vi.mock('next/server', async importOriginal => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/digest-generator', () => ({
  categoriseUncategorisedAttempts: mocks.backfill,
  generateDigestForUser: mocks.generate,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { GET } from '@/app/api/insights/status/route';
import { POST } from '@/app/api/insights/generate/route';

const NOW = new Date('2026-10-12T12:00:00Z');
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const supabase = { from: mocks.from, rpc: mocks.rpc };
  mocks.requireUser.mockResolvedValue({ user: TEST_USER, supabase });
  mocks.createServiceClient.mockReturnValue(supabase);
  mocks.backfill.mockResolvedValue(0);
  mocks.generate.mockResolvedValue({ id: 'digest' });
});
afterEach(() => vi.useRealTimers());
const generate = () => POST(request('/api/insights/generate'));
function prepareGeneration() {
  const cleanup = queryResult();
  const active = queryResult();
  const recent = queryResult([]);
  const insert = queryResult({ id: 'digest' });
  [cleanup, active, recent, insert].forEach(q =>
    mocks.from.mockReturnValueOnce(q)
  );
  mocks.rpc.mockResolvedValue({
    data: [
      {
        total_problems: 10,
        total_attempts: 10,
        total_subjects: 1,
        problems_with_errors: 5,
      },
    ],
    error: null,
  });
  return { cleanup, active, recent, insert };
}

describe('insights status', () => {
  it('requires authentication before loading a digest', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    expect((await GET()).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('returns none when no digest exists and scopes the read to the current user', async () => {
    const read = queryResult();
    mocks.from.mockReturnValue(read);
    expect((await (await GET()).json()).data).toEqual({
      status: 'none',
      digest: null,
    });
    expect(read.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
  });
  it.each(['generating', 'failed'])(
    'returns %s without exposing an unfinished digest',
    async status => {
      mocks.from.mockReturnValue(
        queryResult({ id: 'digest', status, generated_at: NOW.toISOString() })
      );
      expect((await (await GET()).json()).data).toEqual({
        status,
        digest: null,
      });
    }
  );
  it('returns a completed digest intact', async () => {
    const digest = {
      id: 'digest',
      status: 'completed',
      headline: 'Practice functions',
    };
    mocks.from.mockReturnValue(queryResult(digest));
    expect((await (await GET()).json()).data).toEqual({
      status: 'completed',
      digest,
    });
  });
  it('marks a stale generation failed so polling can finish', async () => {
    const update = queryResult();
    mocks.from
      .mockReturnValueOnce(
        queryResult({
          id: 'digest',
          status: 'generating',
          generated_at: '2026-10-12T11:00:00Z',
        })
      )
      .mockReturnValueOnce(update);
    expect((await (await GET()).json()).data).toEqual({
      status: 'failed',
      digest: null,
    });
    expect(update.update).toHaveBeenCalledWith({ status: 'failed' });
    expect(update.eq).toHaveBeenCalledWith('id', 'digest');
  });
  it('keeps polling if persistence of a stale failure fails', async () => {
    mocks.from
      .mockReturnValueOnce(
        queryResult({
          id: 'digest',
          status: 'generating',
          generated_at: '2026-10-12T11:00:00Z',
        })
      )
      .mockReturnValueOnce(queryResult(null, { message: 'write unavailable' }));
    expect((await (await GET()).json()).data).toEqual({
      status: 'generating',
      digest: null,
    });
  });
  it('[AUD-13] does not turn a database read failure into an empty digest history', async () => {
    mocks.from.mockReturnValue(
      queryResult(null, { message: 'database unavailable' })
    );
    const response = await GET();
    expect(response.status).toBe(500);
  });
});

describe('insights generation', () => {
  it('does not allocate background work when the active-generation read fails', async () => {
    mocks.from
      .mockReturnValueOnce(queryResult())
      .mockReturnValueOnce(
        queryResult(null, { message: 'database unavailable' })
      );
    expect((await generate()).status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('requires authentication before allocating background work', async () => {
    mocks.requireUser.mockResolvedValue({ user: null });
    expect((await generate()).status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it('does not continue when stale-generation cleanup fails', async () => {
    mocks.from.mockReturnValue(
      queryResult(null, { message: 'cleanup failed' })
    );
    expect((await generate()).status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it('rejects an overlapping generation without scheduling more AI work', async () => {
    mocks.from
      .mockReturnValueOnce(queryResult())
      .mockReturnValueOnce(queryResult({ id: 'active' }));
    expect((await generate()).status).toBe(409);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('reuses the recent completed digest during the cooldown', async () => {
    const digest = { id: 'recent', status: 'completed' };
    mocks.from
      .mockReturnValueOnce(queryResult())
      .mockReturnValueOnce(queryResult())
      .mockReturnValueOnce(queryResult([digest]));
    expect((await (await generate()).json()).data).toEqual(digest);
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it('returns activity requirements without writing a placeholder for insufficient data', async () => {
    prepareGeneration();
    mocks.rpc.mockResolvedValue({
      data: [
        {
          total_problems: 0,
          total_attempts: 0,
          total_subjects: 0,
          problems_with_errors: 0,
        },
      ],
      error: null,
    });
    const response = await generate();
    expect((await response.json()).data).toMatchObject({
      insufficient_data: true,
      activity_needed: expect.any(Number),
      errors_needed: expect.any(Number),
    });
    expect(mocks.from).toHaveBeenCalledTimes(3);
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it('returns 202 before AI execution and then backfills before generating the digest', async () => {
    const { cleanup, insert } = prepareGeneration();
    const response = await generate();
    expect(response.status).toBe(202);
    expect((await response.json()).data).toEqual({
      id: 'digest',
      status: 'generating',
    });
    expect(cleanup.eq).toHaveBeenCalledWith('user_id', TEST_USER.id);
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: TEST_USER.id, status: 'generating' })
    );
    expect(mocks.generate).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.backfill).toHaveBeenCalledWith(
      TEST_USER.id,
      expect.any(Number)
    );
    expect(mocks.generate).toHaveBeenCalledWith(TEST_USER.id, 'digest');
    expect(mocks.backfill.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generate.mock.invocationCallOrder[0]
    );
  });
  it('persists a failed placeholder when the background provider call fails', async () => {
    prepareGeneration();
    const failure = queryResult();
    mocks.from.mockReturnValueOnce(failure);
    mocks.generate.mockRejectedValue(new Error('provider unavailable'));
    expect((await generate()).status).toBe(202);
    await mocks.after.mock.calls[0][0]();
    expect(failure.update).toHaveBeenCalledWith({ status: 'failed' });
    expect(failure.eq).toHaveBeenCalledWith('id', 'digest');
  });
});
