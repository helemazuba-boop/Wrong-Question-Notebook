import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as recordObservation } from '@/app/api/notes/study/observations/route';
import { POST as skipObservation } from '@/app/api/notes/study/observations/skip/route';

const { mockRequireUser, mockRpc } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('@/lib/supabase/requireUser', () => ({
  requireUser: mockRequireUser,
  unauthorised: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: mockRpc }),
}));

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';
const NOTEBOOK_ID = '55555555-5555-4555-8555-555555555555';

function completedSession() {
  return {
    session_id: SESSION_ID,
    mode: 'sequential',
    status: 'completed',
    notebook_ids: [NOTEBOOK_ID],
    notebook_titles: ['测试笔记本'],
    candidate_count: 1,
    next_sequence: 1,
    started_at: '2026-08-02T03:00:00.000Z',
    last_activity_at: '2026-08-02T04:00:00.000Z',
    expires_at: '2026-08-03T04:00:00.000Z',
    device_id: null,
    current_note_id: null,
    current_note_title: null,
    current_item: null,
    result: {
      opened_count: 0,
      completed_count: 1,
      skipped_count: 0,
    },
  };
}

function request(action: 'opened' | 'read_completed' | 'skipped') {
  return new Request('http://localhost/api/notes/study/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: `webnote_route_${action}_0001`,
      session_id: SESSION_ID,
      sequence: 0,
      item_id: ITEM_ID,
      action,
      mode: 'sequential',
      occurred_at: '2026-08-02T04:00:00.000Z',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    user: { id: USER_ID },
    supabase: {},
    error: null,
  });
});

describe('Web Note reading route adapter', () => {
  it('records read_completed through the canonical RPC as the Web actor', async () => {
    mockRpc.mockResolvedValue({
      data: {
        observation: {
          observation_id: OBSERVATION_ID,
          session_id: SESSION_ID,
          sequence: 0,
          item_id: ITEM_ID,
          action: 'read_completed',
          progress: {
            last_opened_at: '2026-08-02T04:00:00.000+00:00',
            last_completed_at: '2026-08-02T04:00:00.000+00:00',
            completed_count: 1,
          },
          projection_applied: true,
          replayed: false,
        },
        session: completedSession(),
      },
      error: null,
    });

    const response = await recordObservation(request('read_completed'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.observation).toMatchObject({
      action: 'read_completed',
      projection_applied: true,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'record_web_note_study_observation_v2',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_action: 'read_completed',
        p_sequence: 0,
        p_skip: false,
      })
    );
  });

  it('keeps skipped items non-projecting', async () => {
    mockRpc.mockResolvedValue({
      data: {
        observation: {
          observation_id: OBSERVATION_ID,
          session_id: SESSION_ID,
          sequence: 0,
          item_id: ITEM_ID,
          action: 'skipped',
          progress: null,
          projection_applied: false,
          replayed: false,
        },
        session: {
          ...completedSession(),
          result: {
            opened_count: 0,
            completed_count: 0,
            skipped_count: 1,
          },
        },
      },
      error: null,
    });

    const response = await skipObservation(request('skipped'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.observation).toMatchObject({
      action: 'skipped',
      projection_applied: false,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'record_web_note_study_observation_v2',
      expect.objectContaining({ p_skip: true, p_sequence: 0 })
    );
  });

  it('rejects skipped on the projecting route', async () => {
    const response = await recordObservation(request('skipped'));
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
