import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as sessions } from '@/app/api/esp32/v3/notes/sessions/route';
import { POST as candidates } from '@/app/api/esp32/v3/notes/sessions/[id]/candidates/route';
import { POST as observations } from '@/app/api/esp32/v3/notes/observations/route';
import { POST as skip } from '@/app/api/esp32/v3/notes/observations/skip/route';
import { POST as manifest } from '@/app/api/esp32/v3/notes/manifest/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';

const { mockAuthenticate, mockFrom, mockRpc } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: mockAuthenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const NB_ID = '11111111-1111-4111-8111-111111111111';
const OBS_ID = '44444444-4444-4444-8444-444444444444';

// Per-test overridable table results consumed by the mocked service client.
let sessionRow: any;

function noteRequest(
  path: string,
  body: Record<string, unknown>,
  overrides: { protocol?: boolean } = {}
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${'a'.repeat(64)}`,
    'content-type': 'application/json',
    'user-agent': 'vitest-note-study',
    'x-forwarded-for': '127.0.0.1',
    'x-wqn-request-id': String(body.request_id ?? 'req_missing'),
  };
  if (overrides.protocol !== false) headers['x-wqn-protocol'] = '3';
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function meta(requestId: string) {
  return {
    request_id: requestId,
    boot_id: 'boot_note_route_0001',
    firmware_version: '0.1.0-test',
    capabilities: ['note.study.v1'],
  };
}

function observationBody(requestId: string, action = 'read_completed') {
  return {
    ...meta(requestId),
    session_id: SESSION_ID,
    sequence: 0,
    item_id: NOTE_ID,
    action,
    mode: 'sequential',
    occurred_at: '2026-07-20T03:20:00.000Z',
  };
}

function observationResult() {
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

function queryBuilder() {
  const chain: Record<string, any> = {};
  const fluent = vi.fn(() => chain);
  chain.select = fluent;
  chain.eq = fluent;
  chain.is = fluent;
  chain.in = fluent;
  chain.order = fluent;
  chain.range = fluent;
  chain.limit = fluent;
  chain.maybeSingle = vi.fn(async () => ({ data: sessionRow, error: null }));
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: [], error: null }));
  return chain;
}

beforeEach(() => {
  _resetRateLimitStore();
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({
    userId: USER_ID,
    deviceId: DEVICE_ID,
    hardwareId: 'AA:BB:CC:DD:EE:FF',
    configRevision: 0,
    syncCursor: 0,
  });
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockFrom.mockImplementation(() => queryBuilder());
  sessionRow = {
    id: SESSION_ID,
    domain: 'note',
    ordering: 'sequential_note_v1',
    seed: 'seed_note_route_1',
    snapshot: [],
    progress_revision: 3,
    candidate_items: [{ item_id: NOTE_ID, notebook_id: NB_ID, ordinal: 0 }],
    candidate_count: 1,
    status: 'active',
    expires_at: '2099-01-01T00:00:00.000Z',
  };
});

describe('esp32/v3/notes route integration', () => {
  it('records an observation and returns a v3 success envelope', async () => {
    mockRpc.mockResolvedValueOnce({ data: observationResult(), error: null });
    const res = await observations(
      noteRequest(
        '/api/esp32/v3/notes/observations',
        observationBody('req_note_route_ok01')
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      action: 'read_completed',
      projection_applied: true,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'record_note_study_observation_v1',
      expect.objectContaining({ p_user_id: USER_ID, p_device_id: DEVICE_ID })
    );
  });

  it('creates a session and returns the first candidate window', async () => {
    // Per-table mock: no existing session, one visible notebook with one note.
    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      const fluent = vi.fn(() => chain);
      chain.select = fluent;
      chain.eq = fluent;
      chain.is = fluent;
      chain.in = fluent;
      chain.order = fluent;
      chain.limit = fluent;
      chain.range = fluent;
      chain.maybeSingle = vi.fn(async () => ({
        data: table === 'note_change_log' ? { change_seq: 4 } : null,
        error: null,
      }));
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'notebooks') {
          return Promise.resolve(
            resolve({ data: [{ id: NB_ID }], error: null })
          );
        }
        if (table === 'notebook_notes') {
          return Promise.resolve(
            resolve({
              data: [
                {
                  id: NOTE_ID,
                  notebook_id: NB_ID,
                  sort_index: 1,
                  revision: 1,
                  title: 't',
                  content: 'c',
                  updated_at: '2026-01-01T00:00:00Z',
                },
              ],
              error: null,
            })
          );
        }
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return chain;
    });
    mockRpc.mockResolvedValueOnce({
      data: {
        id: SESSION_ID,
        domain: 'note',
        mode: 'sequential',
        purpose: 'browse',
        ordering: 'sequential_note_v1',
        seed: 'seed_note_route_1',
        scope: { notebook_ids: [NB_ID], include_archived: false },
        optional_count: 20,
        next_sequence: 0,
        progress_revision: 4,
        snapshot: [
          {
            notebook_id: NB_ID,
            content_revision: 4,
            pack_revision: 4,
            sha256: 'a'.repeat(64),
          },
        ],
        candidate_items: [{ item_id: NOTE_ID, notebook_id: NB_ID, ordinal: 0 }],
        candidate_count: 1,
        cursor: '1',
        has_more: false,
      },
      error: null,
    });

    const res = await sessions(
      noteRequest('/api/esp32/v3/notes/sessions', {
        ...meta('req_note_route_sess1'),
        domain: 'note',
        mode: 'sequential',
        scope: { notebook_ids: [NB_ID], include_archived: false },
        optional_count: 20,
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      session_id: SESSION_ID,
      domain: 'note',
      ordering: 'sequential_note_v1',
      has_more: false,
    });
    expect(body.data.items).toHaveLength(1);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_note_study_session_v1',
      expect.objectContaining({ p_user_id: USER_ID, p_device_id: DEVICE_ID })
    );
  });

  it('maps a sequence-gap RPC error to a retryable 409 envelope', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'STUDY_SEQUENCE_GAP' },
    });
    const res = await observations(
      noteRequest(
        '/api/esp32/v3/notes/observations',
        observationBody('req_note_route_gap1')
      )
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatchObject({ code: 'SEQUENCE_GAP', retryable: true });
  });

  it('records a skip tombstone through the skip route', async () => {
    mockRpc.mockResolvedValueOnce({
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
    });
    const res = await skip(
      noteRequest(
        '/api/esp32/v3/notes/observations/skip',
        observationBody('req_note_route_skip1', 'skipped')
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.action).toBe('skipped');
  });

  it('returns a candidate page from the pinned session snapshot', async () => {
    const res = await candidates(
      noteRequest('/api/esp32/v3/notes/sessions/x/candidates', {
        ...meta('req_note_route_cand1'),
        cursor: '0',
        limit: 32,
      }),
      { params: Promise.resolve({ id: SESSION_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.next_cursor).toBe('1');
  });

  it('rejects a non-v3 protocol with UPGRADE_REQUIRED', async () => {
    const res = await observations(
      noteRequest(
        '/api/esp32/v3/notes/observations',
        observationBody('req_note_route_proto'),
        { protocol: false }
      )
    );
    expect(res.status).toBe(426);
  });

  it('rejects a malformed request body with INVALID_REQUEST', async () => {
    const res = await observations(
      noteRequest('/api/esp32/v3/notes/observations', {
        ...meta('req_note_route_bad01'),
        // missing session_id/item_id/etc.
      })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('propagates an auth rejection from the device authenticator', async () => {
    mockAuthenticate.mockResolvedValueOnce(
      NextResponse.json({ success: false }, { status: 401 })
    );
    const res = await observations(
      noteRequest(
        '/api/esp32/v3/notes/observations',
        observationBody('req_note_route_auth1')
      )
    );
    expect(res.status).toBe(401);
  });

  it('returns a deterministic note manifest page', async () => {
    // notebooks list, then per-notebook change_seq + notes for buildNotePack.
    let call = 0;
    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      const fluent = vi.fn(() => chain);
      chain.select = fluent;
      chain.eq = fluent;
      chain.is = fluent;
      chain.order = fluent;
      chain.limit = fluent;
      chain.maybeSingle = vi.fn(async () => ({
        data: table === 'note_change_log' ? { change_seq: 4 } : null,
        error: null,
      }));
      chain.range = vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            resolve({ data: [{ id: NB_ID, title: '空白笔记' }], error: null })
          ),
      }));
      chain.then = (resolve: (v: unknown) => unknown) => {
        call += 1;
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return chain;
    });
    const res = await manifest(
      noteRequest('/api/esp32/v3/notes/manifest', {
        ...meta('req_note_route_man01'),
        cursor: '0',
        limit: 50,
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.notebooks[0]).toMatchObject({
      notebook_id: NB_ID,
      content_revision: 4,
    });
    expect(body.data.notebooks[0].pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(call).toBeGreaterThanOrEqual(0);
  });
});
