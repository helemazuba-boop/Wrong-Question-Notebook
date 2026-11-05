import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { POST as registerLocal } from '@/app/api/esp32/v3/words/sessions/local/route';
import { POST as recordBatch } from '@/app/api/esp32/v3/words/observations/batch/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';
import {
  registerLocalWordStudySessionRequestSchema,
  wordObservationBatchRequestSchema,
  wordObservationBatchDataSchema,
  WORD_LOCAL_SESSION_SEMANTICS,
} from '../word-study-longseq-v1';
import {
  localSessionSemanticFingerprint,
  registerLocalWordStudySession,
  recordWordStudyObservationBatch,
} from '../word-study-longseq-service';

const { mockAuthenticate, mockRpc, mockWake } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockRpc: vi.fn(),
  mockWake: vi.fn(),
}));

vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: mockAuthenticate,
}));
vi.mock('@/lib/word-progress-wake', () => ({
  wakeWordProgressProjection: mockWake,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: mockRpc }),
}));

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const SESSION = '88888888-8888-4888-8888-888888888888';
const OBSERVATION = '44444444-4444-4444-8444-444444444444';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'contracts/word-study-v1/fixtures/valid', name),
      'utf8'
    )
  );
}

function request(
  path: string,
  body: Record<string, unknown>,
  extra?: Record<string, string>
) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-longseq',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-request-id': String(body.request_id ?? 'req_missing'),
      'x-wqn-protocol': '3',
      ...(extra ?? {}),
    },
    body: JSON.stringify(body),
  });
}

const serviceClient = { rpc: mockRpc } as never;

beforeEach(() => {
  _resetRateLimitStore();
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({
    userId: USER,
    deviceId: DEVICE,
    hardwareId: 'AA:BB:CC:DD:EE:FF',
    configRevision: 0,
    syncCursor: 0,
  });
});

describe('long-sequence schema and fixed semantics', () => {
  it('freezes server-owned sequential semantics and omits them from requests', () => {
    expect(WORD_LOCAL_SESSION_SEMANTICS).toEqual({
      domain: 'word',
      mode: 'sequential',
      purpose: 'study',
      ordering: 'sequential',
      candidate_policy_version: 'sequential_v1',
    });
    const body = fixture('local-session-request.json');
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse(body).success
    ).toBe(true);
    for (const key of [
      'domain',
      'mode',
      'purpose',
      'ordering',
      'candidate_policy_version',
    ]) {
      expect(
        registerLocalWordStudySessionRequestSchema.safeParse({
          ...body,
          [key]: 'review',
        }).success
      ).toBe(false);
    }
  });

  it('rejects empty scope, non-continuous ordinals and duplicate item IDs', () => {
    const body = fixture('local-session-request.json') as any;
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse({
        ...body,
        scope: { deck_ids: [], include_mastered: true },
      }).success
    ).toBe(false);
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse({
        ...body,
        items: [{ ...body.items[0], ordinal: 1 }, body.items[1]],
      }).success
    ).toBe(false);
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse({
        ...body,
        items: [
          body.items[0],
          { ...body.items[1], item_id: body.items[0].item_id },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects empty, malformed and unbounded batch receipts', () => {
    const session = '33333333-3333-4333-8333-333333333333';
    const accepted = {
      request_id: 'obs_longseq_request_0001',
      observation_id: OBSERVATION,
      sequence: 0,
      replayed: false,
    };
    const failure = {
      request_id: 'obs_longseq_request_0002',
      sequence: 1,
      code: 'SEQUENCE_GAP',
      retryable: true,
    };
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: [],
        failure: null,
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: [accepted],
        failure: { ...failure, sequence: 9 },
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: [{ ...accepted, sequence: Number.MAX_SAFE_INTEGER + 1 }],
        failure,
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: [{ ...accepted, request_id: 'short' }],
        failure,
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: Array.from({ length: 65 }, () => accepted),
        failure: null,
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchDataSchema.safeParse({
        session_id: session,
        accepted: [accepted],
        failure,
      }).success
    ).toBe(true);
  });

  it('rejects non-consecutive sequences and duplicate batch request IDs', () => {
    const body = fixture('observation-batch-request.json') as any;
    expect(wordObservationBatchRequestSchema.safeParse(body).success).toBe(
      true
    );
    expect(
      wordObservationBatchRequestSchema.safeParse({
        ...body,
        observations: [
          body.observations[0],
          { ...body.observations[1], sequence: 7 },
        ],
      }).success
    ).toBe(false);
    expect(
      wordObservationBatchRequestSchema.safeParse({
        ...body,
        observations: [
          body.observations[0],
          {
            ...body.observations[1],
            request_id: body.observations[0].request_id,
          },
        ],
      }).success
    ).toBe(false);
  });
});

describe('long-sequence service', () => {
  it('excludes boot/firmware/transport metadata from the semantic fingerprint', async () => {
    const first = registerLocalWordStudySessionRequestSchema.parse(
      fixture('local-session-request.json')
    );
    const rebooted = registerLocalWordStudySessionRequestSchema.parse({
      ...first,
      request_id: 'req_local_session_000002',
      boot_id: 'boot_local_session_00002',
      firmware_version: '0.2.0-longseq',
      capabilities: ['word.study.longseq.v1'],
    });
    expect(localSessionSemanticFingerprint(first)).toBe(
      localSessionSemanticFingerprint(rebooted)
    );
    expect(localSessionSemanticFingerprint(first)).not.toBe(
      localSessionSemanticFingerprint({
        ...first,
        start_index: first.start_index + 1,
      })
    );

    mockRpc.mockResolvedValueOnce({
      data: { session_id: SESSION, registered: true, replayed: false },
      error: null,
    });
    const result = await registerLocalWordStudySession(
      serviceClient,
      USER,
      DEVICE,
      first
    );
    expect(result.replayed).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith(
      'register_local_word_study_session_v1',
      expect.objectContaining({
        p_user_id: USER,
        p_device_id: DEVICE,
        p_session_id: '33333333-3333-4333-8333-333333333333',
        p_fingerprint: localSessionSemanticFingerprint(first),
        p_start_index: 3507,
      })
    );
  });

  it('maps semantic registration conflicts to stable 409 errors', async () => {
    const body = registerLocalWordStudySessionRequestSchema.parse(
      fixture('local-session-request.json')
    );
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'WORD_LOCAL_SESSION_CONFLICT' },
    });
    await expect(
      registerLocalWordStudySession(serviceClient, USER, DEVICE, body)
    ).rejects.toMatchObject({ status: 409, code: 'LOCAL_SESSION_CONFLICT' });
  });

  it('passes the exact observation array and validates the batch response', async () => {
    const body = wordObservationBatchRequestSchema.parse(
      fixture('observation-batch-request.json')
    );
    mockRpc.mockResolvedValueOnce({
      data: {
        session_id: '33333333-3333-4333-8333-333333333333',
        accepted: [
          {
            request_id: body.observations[0].request_id,
            observation_id: OBSERVATION,
            sequence: 0,
            replayed: false,
          },
        ],
        failure: {
          request_id: body.observations[1].request_id,
          sequence: 1,
          code: 'ITEM_NOT_IN_SESSION',
          retryable: false,
        },
      },
      error: null,
    });
    const result = await recordWordStudyObservationBatch(
      serviceClient,
      USER,
      DEVICE,
      body
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.failure?.code).toBe('ITEM_NOT_IN_SESSION');
    expect(mockRpc).toHaveBeenCalledWith(
      'record_word_study_observation_batch_v1',
      {
        p_user_id: USER,
        p_device_id: DEVICE,
        p_session_id: '33333333-3333-4333-8333-333333333333',
        p_observations: body.observations,
      }
    );
  });

  it('maps unknown DB errors to retryable 503', async () => {
    const body = wordObservationBatchRequestSchema.parse(
      fixture('observation-batch-request.json')
    );
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection reset unexpectedly' },
    });
    await expect(
      recordWordStudyObservationBatch(serviceClient, USER, DEVICE, body)
    ).rejects.toMatchObject({ status: 503, retryable: true });
    expect(mockWake).not.toHaveBeenCalled();
  });

  it('accepts review-mode batches and wakes FSRS projection once for new facts', async () => {
    const base = fixture('observation-batch-request.json') as any;
    const body = wordObservationBatchRequestSchema.parse({
      ...base,
      observations: [
        { ...base.observations[0], mode: 'review' },
        { ...base.observations[1], mode: 'review' },
      ],
    });
    expect(
      wordObservationBatchRequestSchema.safeParse({
        ...base,
        observations: [
          { ...base.observations[0], mode: 'intake' },
          { ...base.observations[1], mode: 'intake' },
        ],
      }).success
    ).toBe(true);
    mockRpc.mockResolvedValueOnce({
      data: {
        session_id: body.session_id,
        accepted: body.observations.map(
          (observation: (typeof body.observations)[number], index: number) => ({
            request_id: observation.request_id,
            observation_id:
              index === 0
                ? OBSERVATION
                : '44444444-4444-4444-8444-444444444445',
            sequence: observation.sequence,
            replayed: false,
          })
        ),
        failure: null,
      },
      error: null,
    });
    const result = await recordWordStudyObservationBatch(
      serviceClient,
      USER,
      DEVICE,
      body
    );
    expect(result.failure).toBeNull();
    expect(result.accepted).toHaveLength(2);
    expect(mockWake).toHaveBeenCalledTimes(1);
  });

  it('does not wake projection for an all-replayed prefix', async () => {
    const body = wordObservationBatchRequestSchema.parse(
      fixture('observation-batch-request.json')
    );
    mockRpc.mockResolvedValueOnce({
      data: {
        session_id: body.session_id,
        accepted: body.observations.map((observation, index) => ({
          request_id: observation.request_id,
          observation_id:
            index === 0 ? OBSERVATION : '44444444-4444-4444-8444-444444444445',
          sequence: observation.sequence,
          replayed: true,
        })),
        failure: null,
      },
      error: null,
    });
    await recordWordStudyObservationBatch(serviceClient, USER, DEVICE, body);
    expect(mockWake).not.toHaveBeenCalled();
  });

  it.each([
    [
      'empty accepted with null failure',
      {
        accepted: [],
        failure: null,
      },
    ],
    [
      'wrong session id',
      {
        accepted: [
          {
            request_id: 'obs_longseq_request_0001',
            observation_id: OBSERVATION,
            sequence: 0,
            replayed: false,
          },
        ],
        failure: {
          request_id: 'obs_longseq_request_0002',
          sequence: 1,
          code: 'SEQUENCE_GAP',
          retryable: true,
        },
      },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ],
    [
      'accepted prefix request id mismatch',
      {
        accepted: [
          {
            request_id: 'forged_request_id_000001',
            observation_id: OBSERVATION,
            sequence: 0,
            replayed: false,
          },
        ],
        failure: {
          request_id: 'obs_longseq_request_0002',
          sequence: 1,
          code: 'SEQUENCE_GAP',
          retryable: true,
        },
      },
    ],
    [
      'failure not immediately after accepted prefix',
      {
        accepted: [],
        failure: {
          request_id: 'obs_longseq_request_0002',
          sequence: 1,
          code: 'SEQUENCE_GAP',
          retryable: true,
        },
      },
    ],
    [
      'all accepted but failure non-null',
      {
        accepted: [
          {
            request_id: 'obs_longseq_request_0001',
            observation_id: OBSERVATION,
            sequence: 0,
            replayed: false,
          },
          {
            request_id: 'obs_longseq_request_0002',
            observation_id: OBSERVATION,
            sequence: 1,
            replayed: false,
          },
        ],
        failure: {
          request_id: 'obs_longseq_request_0002',
          sequence: 1,
          code: 'SEQUENCE_GAP',
          retryable: true,
        },
      },
    ],
  ])(
    'rejects malformed RPC receipt: %s',
    async (_label, receipt, sessionId) => {
      const body = wordObservationBatchRequestSchema.parse(
        fixture('observation-batch-request.json')
      );
      mockRpc.mockResolvedValueOnce({
        data: {
          session_id: sessionId ?? body.session_id,
          ...receipt,
        },
        error: null,
      });
      await expect(
        recordWordStudyObservationBatch(serviceClient, USER, DEVICE, body)
      ).rejects.toMatchObject({ status: 503, code: 'INVALID_STUDY_RESULT' });
      expect(mockWake).not.toHaveBeenCalled();
    }
  );
});

describe('long-sequence routes', () => {
  it('registers a local session through the authenticated actor only', async () => {
    const body = fixture('local-session-request.json');
    mockRpc.mockResolvedValueOnce({
      data: { session_id: SESSION, registered: true, replayed: false },
      error: null,
    });
    const res = await registerLocal(
      request('/api/esp32/v3/words/sessions/local', body)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      session_id: SESSION,
      registered: true,
      replayed: false,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'register_local_word_study_session_v1',
      expect.objectContaining({ p_user_id: USER, p_device_id: DEVICE })
    );
  });

  it('preserves authentication 401 without invoking the database', async () => {
    mockAuthenticate.mockResolvedValueOnce(
      NextResponse.json({ ok: false }, { status: 401 })
    );
    const res = await registerLocal(
      request(
        '/api/esp32/v3/words/sessions/local',
        fixture('local-session-request.json')
      )
    );
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects bodies beyond the streamed byte limit even with a lying Content-Length', async () => {
    const body = fixture('local-session-request.json');
    const huge = { ...body, seed: 'x'.repeat(130 * 1024) };
    const res = await registerLocal(
      request('/api/esp32/v3/words/sessions/local', huge, {
        'content-length': '10',
      })
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('BODY_TOO_LARGE');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns the accepted prefix and failure for a batch', async () => {
    const body = fixture('observation-batch-request.json');
    mockRpc.mockResolvedValueOnce({
      data: {
        session_id: '33333333-3333-4333-8333-333333333333',
        accepted: [
          {
            request_id: 'obs_longseq_request_0001',
            observation_id: OBSERVATION,
            sequence: 0,
            replayed: false,
          },
        ],
        failure: {
          request_id: 'obs_longseq_request_0002',
          sequence: 1,
          code: 'SEQUENCE_GAP',
          retryable: true,
        },
      },
      error: null,
    });
    const res = await recordBatch(
      request('/api/esp32/v3/words/observations/batch', body)
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.accepted).toHaveLength(1);
    expect(payload.data.failure.code).toBe('SEQUENCE_GAP');
  });

  it('maps batch DB semantic errors without claiming an auth failure', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'WORD_LOCAL_DEVICE_NOT_OWNED' },
    });
    const res = await recordBatch(
      request(
        '/api/esp32/v3/words/observations/batch',
        fixture('observation-batch-request.json')
      )
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('DEVICE_NOT_OWNED');
  });

  it('returns retryable 503 when an unknown DB error rolls back the prefix', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'injected unexpected projection failure' },
    });
    const res = await recordBatch(
      request(
        '/api/esp32/v3/words/observations/batch',
        fixture('observation-batch-request.json')
      )
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({
      code: 'WORD_STUDY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('never emits a success envelope from a malformed RPC receipt', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        session_id: '33333333-3333-4333-8333-333333333333',
        accepted: [],
        failure: null,
      },
      error: null,
    });
    const res = await recordBatch(
      request(
        '/api/esp32/v3/words/observations/batch',
        fixture('observation-batch-request.json')
      )
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.retryable).toBe(true);
  });
});
