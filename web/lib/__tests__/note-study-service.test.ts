import { describe, expect, it, vi } from 'vitest';
import {
  isNoteStudySessionSnapshotReadable,
  loadNoteStudyCandidatePage,
  mergeNoteStudyCandidatePage,
  recordNoteStudyObservation,
  skipNoteStudyObservation,
} from '@/lib/note-study-service';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '77777777-7777-4777-8777-777777777777';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const NB_ID = '11111111-1111-4111-8111-111111111111';
const OBS_ID = '44444444-4444-4444-8444-444444444444';

const META = {
  request_id: 'req_note_observe_00001',
  boot_id: 'boot_note_00000001',
  firmware_version: '0.1.0',
  capabilities: ['note.study.v1'],
} as const;

function observationInput(action: string) {
  return {
    ...META,
    session_id: SESSION_ID,
    sequence: 0,
    item_id: NOTE_ID,
    action,
    mode: 'sequential',
    occurred_at: '2026-07-20T03:20:00.000Z',
  } as any;
}

function readCompletedResult() {
  return {
    observation_id: OBS_ID,
    session_id: SESSION_ID,
    sequence: 0,
    item_id: NOTE_ID,
    action: 'read_completed',
    progress: {
      last_opened_at: '2026-07-20T03:19:00.000Z',
      last_completed_at: '2026-07-20T03:20:00.000Z',
      completed_count: 1,
    },
    projection_applied: true,
    replayed: false,
  };
}

function chain(result: any) {
  const q: any = {};
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit']) {
    q[m] = vi.fn(() => q);
  }
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: any, reject: any) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function makeClient(opts: {
  tables?: Record<string, any[]>;
  rpc?: Record<string, any>;
}) {
  const counters: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    const idx = counters[table] ?? 0;
    counters[table] = idx + 1;
    const list = opts.tables?.[table] || [];
    return chain(
      list[Math.min(idx, list.length - 1)] ?? { data: null, error: null }
    );
  });
  const rpc = vi.fn((name: string) =>
    Promise.resolve(opts.rpc?.[name] ?? { data: null, error: null })
  );
  return { supabase: { from, rpc } as any, rpc };
}

describe('recordNoteStudyObservation', () => {
  it('returns the parsed observation on success', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: readCompletedResult(),
          error: null,
        },
      },
    });
    const result = await recordNoteStudyObservation(
      supabase,
      USER_ID,
      DEVICE_ID,
      observationInput('read_completed')
    );
    expect(result.action).toBe('read_completed');
    expect(result.progress).toMatchObject({ completed_count: 1 });
    expect(result.replayed).toBe(false);
  });

  it('maps a sequence gap to a retryable 409', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: null,
          error: { message: 'STUDY_SEQUENCE_GAP' },
        },
      },
    });
    await expect(
      recordNoteStudyObservation(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('opened')
      )
    ).rejects.toMatchObject({
      code: 'SEQUENCE_GAP',
      status: 409,
      retryable: true,
    });
  });

  it('treats an equivalent applied sequence as an idempotent replay', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: null,
          error: { message: 'STUDY_SEQUENCE_ALREADY_APPLIED' },
        },
      },
      tables: {
        study_observations: [
          {
            data: {
              item_id: NOTE_ID,
              action: 'read_completed',
              mode: 'sequential',
              result: readCompletedResult(),
            },
            error: null,
          },
        ],
      },
    });
    const result = await recordNoteStudyObservation(supabase, USER_ID, null, {
      ...observationInput('read_completed'),
      request_id: 'webnote_recovery_new_request',
    });
    expect(result).toMatchObject({
      item_id: NOTE_ID,
      action: 'read_completed',
      replayed: true,
    });
  });

  it('keeps an applied sequence conflicting when the action differs', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: null,
          error: { message: 'STUDY_SEQUENCE_ALREADY_APPLIED' },
        },
      },
      tables: {
        study_observations: [
          {
            data: {
              item_id: NOTE_ID,
              action: 'opened',
              mode: 'sequential',
              result: { ...readCompletedResult(), action: 'opened' },
            },
            error: null,
          },
        ],
      },
    });
    await expect(
      recordNoteStudyObservation(
        supabase,
        USER_ID,
        null,
        observationInput('read_completed')
      )
    ).rejects.toMatchObject({
      code: 'SEQUENCE_ALREADY_APPLIED',
      status: 409,
    });
  });

  it('maps an actor mismatch to 403', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: null,
          error: { message: 'STUDY_SESSION_ACTOR_MISMATCH' },
        },
      },
    });
    await expect(
      recordNoteStudyObservation(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('opened')
      )
    ).rejects.toMatchObject({ code: 'SESSION_ACTOR_MISMATCH', status: 403 });
  });

  it('rejects a malformed RPC result shape', async () => {
    const { supabase } = makeClient({
      rpc: {
        record_note_study_observation_v1: {
          data: { observation_id: 'not-a-uuid' },
          error: null,
        },
      },
    });
    await expect(
      recordNoteStudyObservation(
        supabase,
        USER_ID,
        DEVICE_ID,
        observationInput('opened')
      )
    ).rejects.toMatchObject({ code: 'INVALID_STUDY_RESULT', status: 503 });
  });
});

describe('skipNoteStudyObservation', () => {
  it('returns the parsed skip tombstone', async () => {
    const { supabase } = makeClient({
      rpc: {
        skip_note_study_observation_v1: {
          data: {
            observation_id: OBS_ID,
            session_id: SESSION_ID,
            sequence: 0,
            item_id: NOTE_ID,
            action: 'skipped',
            progress: null,
            projection_applied: false,
            replayed: false,
          },
          error: null,
        },
      },
    });
    const result = await skipNoteStudyObservation(
      supabase,
      USER_ID,
      DEVICE_ID,
      observationInput('skipped')
    );
    expect(result.action).toBe('skipped');
    expect(result.progress).toBeNull();
  });
});

describe('loadNoteStudyCandidatePage', () => {
  const sessionRow = {
    id: SESSION_ID,
    domain: 'note',
    ordering: 'sequential_note_v1',
    seed: 'seed_note_0001',
    snapshot: [],
    progress_revision: 5,
    candidate_items: [
      { item_id: NOTE_ID, notebook_id: NB_ID, ordinal: 0 },
      {
        item_id: '33333333-3333-4333-8333-333333333334',
        notebook_id: NB_ID,
        ordinal: 1,
      },
    ],
    candidate_count: 2,
    status: 'active',
    expires_at: '2099-01-01T00:00:00.000Z',
  };

  it('returns a contiguous page with next_cursor', async () => {
    const { supabase } = makeClient({
      tables: { study_sessions: [{ data: sessionRow, error: null }] },
    });
    const page = await loadNoteStudyCandidatePage(
      supabase,
      USER_ID,
      DEVICE_ID,
      SESSION_ID,
      { ...META, cursor: '0' } as any
    );
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe('2');
    expect(page.has_more).toBe(false);
    expect(page.candidate_policy_version).toBe('sequential_note_v1');
  });

  it('rejects a non-note session as not found', async () => {
    const { supabase } = makeClient({
      tables: {
        study_sessions: [
          { data: { ...sessionRow, domain: 'word' }, error: null },
        ],
      },
    });
    await expect(
      loadNoteStudyCandidatePage(supabase, USER_ID, DEVICE_ID, SESSION_ID, {
        ...META,
        cursor: '0',
      } as any)
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 });
  });

  it('rejects an expired/inactive session snapshot', async () => {
    const { supabase } = makeClient({
      tables: {
        study_sessions: [
          {
            data: { ...sessionRow, expires_at: '2000-01-01T00:00:00.000Z' },
            error: null,
          },
        ],
      },
    });
    await expect(
      loadNoteStudyCandidatePage(supabase, USER_ID, DEVICE_ID, SESSION_ID, {
        ...META,
        cursor: '0',
      } as any)
    ).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE', status: 409 });
  });
});

describe('note-study runtime guards', () => {
  it('treats active/paused/abandoned unexpired sessions as readable', () => {
    const future = '2099-01-01T00:00:00.000Z';
    expect(isNoteStudySessionSnapshotReadable('active', future)).toBe(true);
    expect(isNoteStudySessionSnapshotReadable('paused', future)).toBe(true);
    expect(isNoteStudySessionSnapshotReadable('abandoned', future)).toBe(true);
    expect(isNoteStudySessionSnapshotReadable('completed', future)).toBe(false);
    expect(
      isNoteStudySessionSnapshotReadable('active', '2000-01-01T00:00:00Z')
    ).toBe(false);
  });

  it('bounds a merged candidate page to the output limit', () => {
    const pool = [
      {
        item_id: 'a',
        notebook_id: NB_ID,
        notebook_order: 0,
        sort_index: 1,
        last_opened_at: null,
        created_at: 't',
      },
    ];
    const page = [
      {
        item_id: 'b',
        notebook_id: NB_ID,
        notebook_order: 0,
        sort_index: 2,
        last_opened_at: null,
        created_at: 't',
      },
      {
        item_id: 'c',
        notebook_id: NB_ID,
        notebook_order: 0,
        sort_index: 3,
        last_opened_at: null,
        created_at: 't',
      },
    ];
    const merged = mergeNoteStudyCandidatePage(
      pool,
      page,
      'sequential_note_v1',
      2
    );
    expect(merged.map(c => c.item_id)).toEqual(['a', 'b']);
  });
});
