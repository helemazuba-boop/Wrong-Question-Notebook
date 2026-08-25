import { describe, expect, it, vi } from 'vitest';
import {
  advanceWebNoteStudyObservation,
  loadRecentNoteReads,
  loadWebNoteStudySession,
} from '@/lib/note-study-web';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const NOTEBOOK_ID = '55555555-5555-4555-8555-555555555555';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';

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

describe('Web Note study RPC adapters', () => {
  it('loads a render-ready session in one RPC call', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: completedSession(),
      error: null,
    });

    const result = await loadWebNoteStudySession(
      { rpc } as any,
      USER_ID,
      SESSION_ID
    );

    expect(result.status).toBe('completed');
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('get_web_note_study_session_v2', {
      p_user_id: USER_ID,
      p_session_id: SESSION_ID,
    });
  });

  it('returns the observation and next render state atomically', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        observation: {
          observation_id: OBSERVATION_ID,
          session_id: SESSION_ID,
          sequence: 0,
          item_id: NOTE_ID,
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

    const result = await advanceWebNoteStudyObservation(
      { rpc } as any,
      USER_ID,
      {
        request_id: 'webnote_observation_1234567890',
        session_id: SESSION_ID,
        sequence: 0,
        item_id: NOTE_ID,
        action: 'read_completed',
        mode: 'sequential',
        occurred_at: '2026-08-02T04:00:00.000Z',
      }
    );

    expect(result.session.next_sequence).toBe(1);
    expect(rpc).toHaveBeenCalledWith(
      'record_web_note_study_observation_v2',
      expect.objectContaining({ p_skip: false, p_sequence: 0 })
    );
  });

  it('loads recent reads through the joined database projection', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          note_id: NOTE_ID,
          notebook_id: NOTEBOOK_ID,
          notebook_title: '测试笔记本',
          note_title: '第一篇',
          state: 'completed',
          last_opened_at: '2026-08-02T04:00:00.000Z',
          last_completed_at: '2026-08-02T04:00:00.000Z',
          completed_count: 1,
          actor: 'web',
        },
      ],
      error: null,
    });

    const result = await loadRecentNoteReads({ rpc } as any, USER_ID, {
      notebook_id: NOTEBOOK_ID,
      limit: 8,
    });

    expect(result).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('get_recent_note_reads_v2', {
      p_user_id: USER_ID,
      p_notebook_id: NOTEBOOK_ID,
      p_limit: 8,
    });
  });
});
