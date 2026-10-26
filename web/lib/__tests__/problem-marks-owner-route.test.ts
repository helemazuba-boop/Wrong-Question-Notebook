import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  read: vi.fn(),
  wake: vi.fn(),
  limit: vi.fn(),
  maybe: vi.fn(),
}));
vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: m.auth,
  unauthorised: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: m.rpc }),
}));
vi.mock('@/lib/problem-marks/read', () => ({ readProblemSemantics: m.read }));
vi.mock('@/lib/problem-marks/wake', () => ({
  wakeProblemMarkAnnotation: m.wake,
}));
vi.mock('@/lib/rate-limit', () => ({ consumeRateLimit: m.limit }));
import { GET, POST } from '@/app/api/problems/[id]/marks/route';
const id = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.clearAllMocks();
  const q = { select: () => q, eq: () => q, maybeSingle: m.maybe };
  m.auth.mockResolvedValue({
    user: { id: 'owner' },
    supabase: { from: () => q },
  });
  m.maybe.mockResolvedValue({ data: { id }, error: null });
  m.limit.mockReturnValue({ ok: true });
  m.rpc.mockResolvedValue({ data: {}, error: null });
  m.read.mockResolvedValue({ annotation_status: 'pending' });
});
describe('Owner classification polling and explicit retry', () => {
  it('requires a verified user', async () => {
    m.auth.mockResolvedValue({ user: null });
    expect((await GET(new Request('http://wqn'), ctx)).status).toBe(401);
    expect((await POST(new Request('http://wqn'), ctx)).status).toBe(401);
  });
  it('reads only the semantic projection', async () => {
    const r = await GET(new Request('http://wqn'), ctx);
    expect((await r.json()).data.annotation_status).toBe('pending');
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('refuses retries for a non-owned Problem', async () => {
    m.maybe.mockResolvedValue({ data: null, error: null });
    expect((await POST(new Request('http://wqn'), ctx)).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('requeues one owned retry and wakes the selected backend', async () => {
    expect((await POST(new Request('http://wqn'), ctx)).status).toBe(202);
    expect(m.rpc).toHaveBeenCalledWith('requeue_problem_mark_annotation', {
      p_problem_id: id,
    });
    expect(m.wake).toHaveBeenCalledWith(id);
  });
  it('does not duplicate a pending or leased task', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { message: 'PROBLEM_MARK_ANNOTATION_NOT_REQUEUEABLE' },
    });
    expect((await POST(new Request('http://wqn'), ctx)).status).toBe(409);
    expect(m.wake).not.toHaveBeenCalled();
  });
});
