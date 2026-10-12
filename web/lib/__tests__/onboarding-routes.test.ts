import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryResult, request, TEST_USER } from '@/lib/test/supabase-query';
const mocks = vi.hoisted(() => ({ user: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mocks.user,
  unauthorised: () =>
    NextResponse.json({ error: 'Unauthorised' }, { status: 401 }),
}));
vi.mock('@/lib/security-middleware', () => ({
  withSecurity: (handler: unknown) => handler,
}));
import { GET, POST as choose } from '@/app/api/onboarding/status/route';
import { POST as complete } from '@/app/api/onboarding/complete/route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({
    user: TEST_USER,
    supabase: { from: mocks.from },
  });
});
function fixture(scenario: string | null, counts: number[] = [0, 0, 0, 0]) {
  mocks.from.mockReturnValueOnce(
    queryResult({ onboarding_scenario: scenario })
  );
  counts.forEach(count =>
    mocks.from.mockReturnValueOnce(queryResult(null, null, count))
  );
}
describe('scenario onboarding', () => {
  it.each([GET, choose, complete])(
    'denies anonymous callers',
    async handler => {
      mocks.user.mockResolvedValue({ user: null });
      expect(
        (await handler(request('/api/onboarding/status', {}))).status
      ).toBe(401);
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
  it('asks for a workflow without treating preset subjects as user progress', async () => {
    fixture(null);
    const result = await GET();
    expect((await result.json()).data).toMatchObject({
      scenario: null,
      hasContainer: false,
      hasContent: false,
      hasPracticed: false,
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it.each(['problems', 'notes', 'words'])(
    'requires actual owned activity for %s',
    async scenario => {
      fixture(scenario);
      const response = await GET();
      expect((await response.json()).data).toMatchObject({
        scenario,
        hasContainer: false,
        hasContent: false,
        hasPracticed: false,
      });
    }
  );
  it('does not require question activity in the note workflow', async () => {
    fixture('notes', [1, 1, 1]);
    expect((await (await GET()).json()).data).toMatchObject({
      hasContainer: true,
      hasContent: true,
      hasPracticed: true,
    });
    expect(mocks.from.mock.calls.map(call => call[0])).not.toContain(
      'problems'
    );
  });
  it('rejects incomplete workflow completion', async () => {
    fixture('notes');
    expect(
      (await complete(request('/api/onboarding/complete', {}))).status
    ).toBe(409);
  });
  it('keeps dismissal separate from completion', async () => {
    const update = queryResult();
    mocks.from.mockReturnValue(update);
    const response = await complete(
      request('/api/onboarding/complete', { dismiss: true })
    );
    expect((await response.json()).data).toEqual({
      completed: false,
      dismissed: true,
    });
    expect(update.update).toHaveBeenCalledWith({
      onboarding_dismissed_at: expect.any(String),
    });
    expect(update.is).toHaveBeenCalledWith('onboarding_dismissed_at', null);
  });
  it('preserves the first completion timestamp when the chosen workflow is finished', async () => {
    fixture('notes', [1, 1, 1]);
    const update = queryResult();
    mocks.from.mockReturnValueOnce(update);
    expect(
      (await complete(request('/api/onboarding/complete', {}))).status
    ).toBe(200);
    expect(update.update).toHaveBeenCalledWith({
      onboarding_completed_at: expect.any(String),
    });
    expect(update.eq).toHaveBeenCalledWith('id', TEST_USER.id);
    expect(update.is).toHaveBeenCalledWith('onboarding_completed_at', null);
  });
  it('returns a fault when status reads fail', async () => {
    mocks.from.mockReturnValue(queryResult(null, { message: 'offline' }));
    expect((await GET()).status).toBe(503);
  });
  it('rejects unknown workflows before persistence', async () => {
    expect(
      (await choose(request('/api/onboarding/status', { scenario: 'all' })))
        .status
    ).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
