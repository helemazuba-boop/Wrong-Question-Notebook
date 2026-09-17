import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isCurrentUserSuperAdmin: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/user-management', () => ({
  isCurrentUserSuperAdmin: mocks.isCurrentUserSuperAdmin,
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}));

import { GET, POST } from '@/app/api/admin/problem-marks/route';

const PROBLEM_ID = '33000000-0000-4000-8000-0000000000aa';

function post(body: unknown) {
  return new Request('http://localhost/api/admin/problem-marks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCurrentUserSuperAdmin.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: { status_counts: [] }, error: null });
});

describe('admin problem-marks route', () => {
  it('rejects a non-super-admin read without touching the queue', async () => {
    mocks.isCurrentUserSuperAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns queue health to a super admin', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('problem_mark_annotation_health');
    const body = await response.json();
    expect(body.health).toEqual({ status_counts: [] });
  });

  it('rejects a non-super-admin action', async () => {
    mocks.isCurrentUserSuperAdmin.mockResolvedValue(false);
    const response = await POST(post({ action: 'all' }));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects an action with no target', async () => {
    const response = await POST(post({ action: 'nonsense' }));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects a single-problem action with a non-UUID target', async () => {
    const response = await POST(post({ action: 'problem', problem_id: 'no' }));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('requeues one Problem by id', async () => {
    const response = await POST(
      post({ action: 'problem', problem_id: PROBLEM_ID })
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('requeue_problem_mark_annotation', {
      p_problem_id: PROBLEM_ID,
    });
  });

  it('requeues the whole backlog only when asked explicitly', async () => {
    const response = await POST(post({ action: 'all' }));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'requeue_all_problem_mark_annotations'
    );
  });

  it('reports a failed requeue as a conflict', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'leased' } });
    const response = await POST(
      post({ action: 'problem', problem_id: PROBLEM_ID })
    );
    expect(response.status).toBe(409);
  });
});
