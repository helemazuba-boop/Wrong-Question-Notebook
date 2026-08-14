import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as completeReview } from '@/app/api/esp32/review-complete/route';
import {
  deterministicDeviceAttemptId,
  deterministicDeviceReviewId,
} from '@/lib/device-control-v3-idempotency';

const { mockAuthenticate, mockFrom, mockRpc, mockRevalidate } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
    mockRevalidate: vi.fn(),
  })
);

vi.mock('@/lib/esp32-device-auth', () => ({
  authenticateEsp32Device: mockAuthenticate,
}));

vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

vi.mock('@/lib/cache-invalidation', () => ({
  revalidateUserReviewSchedule: mockRevalidate,
}));

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROBLEM_IDS = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333',
];
const REQUEST_ID = 'legacy_review_req_0001';

type ReviewRow = {
  id: string;
  review_occurrence_id: string;
  problem_id: string;
  attempt_id: string | null;
  event_kind: string;
  human_rating: string | null;
  machine_correctness_snapshot: boolean | null;
  channel_source: string;
};

const storedReviewRows = new Map<string, ReviewRow>();
let storedIdempotencyResponse: unknown = null;
let attemptUpserts: unknown[] = [];

function request(results: unknown[], requestId = REQUEST_ID) {
  return new NextRequest('http://localhost/api/esp32/review-complete', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'a'.repeat(64)}`,
      'content-type': 'application/json',
      'user-agent': 'vitest-legacy-review',
      'x-forwarded-for': '127.0.0.1',
      'x-wqn-request-id': requestId,
    },
    body: JSON.stringify({ results }),
  });
}

function tableBuilder(table: string) {
  const filters = new Map<string, unknown>();
  let inserted: Record<string, unknown> | null = null;
  let updated: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((column: string, value: unknown) => {
    filters.set(column, value);
    return chain;
  });
  chain.insert = vi.fn((value: Record<string, unknown>) => {
    inserted = value;
    return Promise.resolve({ data: null, error: null });
  });
  chain.upsert = vi.fn((value: Record<string, unknown>) => {
    attemptUpserts.push(value);
    return Promise.resolve({ data: null, error: null });
  });
  chain.update = vi.fn((value: Record<string, unknown>) => {
    updated = value;
    return chain;
  });
  chain.delete = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => {
    if (table === 'esp32_request_idempotency') {
      return { data: storedIdempotencyResponse, error: null };
    }
    if (table === 'problems') {
      return { data: { id: filters.get('id') }, error: null };
    }
    if (table === 'problem_review_events') {
      return {
        data:
          storedReviewRows.get(String(filters.get('source_request_id'))) ??
          null,
        error: null,
      };
    }
    return { data: null, error: null };
  });
  chain.single = vi.fn(async () => ({
    data: storedIdempotencyResponse,
    error: null,
  }));
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown
  ) => {
    try {
      if (table === 'esp32_request_idempotency' && inserted) {
        storedIdempotencyResponse = inserted;
      }
      if (table === 'esp32_request_idempotency' && updated) {
        storedIdempotencyResponse = {
          endpoint: 'legacy-review-complete',
          request_fingerprint: filters.get('request_fingerprint'),
          http_status: updated.http_status,
          response_body: updated.response_body,
        };
      }
      return Promise.resolve(resolve({ data: null, error: null }));
    } catch (error) {
      return Promise.resolve(reject(error));
    }
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedReviewRows.clear();
  storedIdempotencyResponse = null;
  attemptUpserts = [];
  mockAuthenticate.mockResolvedValue({ userId: USER_ID, deviceId: DEVICE_ID });
  mockFrom.mockImplementation((table: string) => tableBuilder(table));
  mockRpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (name === 'record_problem_review_fact') {
        storedReviewRows.set(String(args.p_source_request_id), {
          id: String(args.p_event_id),
          review_occurrence_id: String(args.p_review_occurrence_id),
          problem_id: String(args.p_problem_id),
          attempt_id: args.p_attempt_id ? String(args.p_attempt_id) : null,
          event_kind: String(args.p_event_kind),
          human_rating: args.p_human_rating
            ? String(args.p_human_rating)
            : null,
          machine_correctness_snapshot:
            typeof args.p_machine_correctness_snapshot === 'boolean'
              ? args.p_machine_correctness_snapshot
              : null,
          channel_source: String(args.p_channel_source),
        });
      }
      return { data: null, error: null };
    }
  );
  mockRevalidate.mockResolvedValue(undefined);
});

describe('legacy ESP32 Review completion', () => {
  it('maps device verdicts into immutable human Ratings without invoking v1 SM-2', async () => {
    const results = PROBLEM_IDS.map((problemId, index) => ({
      problem_id: problemId,
      selected_status: ['wrong', 'needs_review', 'mastered'][index],
      submitted_answer: { text: `answer-${index}` },
      is_correct: index === 2,
    }));

    const response = await completeReview(request(results));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.processed).toBe(3);
    const factCalls = mockRpc.mock.calls.filter(
      ([name]) => name === 'record_problem_review_fact'
    );
    expect(factCalls.map(([, args]) => args.p_human_rating)).toEqual([
      'Again',
      'Hard',
      'Good',
    ]);
    expect(mockRpc).not.toHaveBeenCalledWith(
      'record_problem_review_v1',
      expect.anything()
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      'update_review_schedule',
      expect.anything()
    );
    expect(attemptUpserts).toHaveLength(3);
    expect(factCalls[0][1]).toMatchObject({
      p_attempt_id: deterministicDeviceAttemptId(
        DEVICE_ID,
        REQUEST_ID,
        0,
        PROBLEM_IDS[0]
      ),
      p_review_occurrence_id: deterministicDeviceReviewId(
        DEVICE_ID,
        REQUEST_ID,
        0
      ),
      p_machine_correctness_snapshot: false,
      p_channel_source: 'device',
    });
  });

  it('replays a partially persisted batch without changing occurrence identity or Review time', async () => {
    const results = [
      {
        problem_id: PROBLEM_IDS[0],
        selected_status: 'needs_review',
        submitted_answer: { text: 'first' },
        is_correct: false,
      },
      {
        problem_id: PROBLEM_IDS[1],
        selected_status: 'mastered',
        submitted_answer: { text: 'second' },
        is_correct: true,
      },
    ];
    let failedOnce = false;
    mockRpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name !== 'record_problem_review_fact')
          return { data: null, error: null };
        if (args.p_problem_id === PROBLEM_IDS[1] && !failedOnce) {
          failedOnce = true;
          return { data: null, error: { message: 'temporary failure' } };
        }
        storedReviewRows.set(String(args.p_source_request_id), {
          id: String(args.p_event_id),
          review_occurrence_id: String(args.p_review_occurrence_id),
          problem_id: String(args.p_problem_id),
          attempt_id: args.p_attempt_id ? String(args.p_attempt_id) : null,
          event_kind: String(args.p_event_kind),
          human_rating: String(args.p_human_rating),
          machine_correctness_snapshot:
            typeof args.p_machine_correctness_snapshot === 'boolean'
              ? args.p_machine_correctness_snapshot
              : null,
          channel_source: String(args.p_channel_source),
        });
        return { data: null, error: null };
      }
    );

    expect((await completeReview(request(results))).status).toBe(500);
    storedIdempotencyResponse = null;
    const retry = await completeReview(request(results));
    const body = await retry.json();

    expect(retry.status).toBe(200);
    expect(body.data.processed).toBe(2);
    const firstProblemCalls = mockRpc.mock.calls.filter(
      ([name, args]) =>
        name === 'record_problem_review_fact' &&
        args.p_problem_id === PROBLEM_IDS[0]
    );
    expect(firstProblemCalls).toHaveLength(1);
    expect(storedReviewRows.size).toBe(2);
  });
});
