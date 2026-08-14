import { describe, expect, it } from 'vitest';
import {
  createWebWordRequestId,
  dispositionForPendingObservation,
  parsePendingWebWordObservation,
  readWordStudyStorage,
  removeWordStudyStorage,
  writeWordStudyStorage,
  type PendingWebWordObservation,
} from '../word-study-client';

const SESSION_ID = '88888888-8888-4888-8888-888888888888';

function pending(
  overrides: Partial<PendingWebWordObservation> = {}
): PendingWebWordObservation {
  return {
    request_id: 'webobservation_1234567890abcdef',
    session_id: SESSION_ID,
    sequence: 3,
    item_id: '33333333-3333-4333-8333-333333333333',
    action: 'unknown',
    mode: 'random',
    occurred_at: '2026-08-01T04:00:00.000Z',
    ...overrides,
  };
}

describe('Web Word study pending observation recovery', () => {
  it('generates protocol-compatible idempotency keys', () => {
    const requestId = createWebWordRequestId('webobservation');
    expect(requestId.length).toBeGreaterThanOrEqual(16);
    expect(requestId.length).toBeLessThanOrEqual(64);
    expect(requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a pending observation only for the expected session', () => {
    const serialized = JSON.stringify(pending({ action: 'looked_up' }));
    expect(
      parsePendingWebWordObservation(serialized, SESSION_ID)
    ).toMatchObject({
      session_id: SESSION_ID,
      sequence: 3,
      action: 'looked_up',
    });
    expect(
      parsePendingWebWordObservation(
        serialized,
        '99999999-9999-4999-8999-999999999999'
      )
    ).toBeNull();
  });

  it('retries only the exact next sequence', () => {
    const observation = pending();
    expect(dispositionForPendingObservation(3, observation)).toBe('retry');
    expect(dispositionForPendingObservation(4, observation)).toBe(
      'already_applied'
    );
    expect(dispositionForPendingObservation(2, observation)).toBe(
      'invalid_gap'
    );
  });

  it('rejects malformed or non-durable local payloads', () => {
    expect(parsePendingWebWordObservation('{', SESSION_ID)).toBeNull();
    expect(
      parsePendingWebWordObservation(
        JSON.stringify(pending({ request_id: 'short' })),
        SESSION_ID
      )
    ).toBeNull();
    expect(
      parsePendingWebWordObservation(
        JSON.stringify({ ...pending(), sequence: 1.5 }),
        SESSION_ID
      )
    ).toBeNull();
  });

  it('degrades safely when browser storage is unavailable', () => {
    const unavailable = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;

    expect(readWordStudyStorage(unavailable, 'key')).toBeNull();
    expect(writeWordStudyStorage(unavailable, 'key', 'value')).toBe(false);
    expect(() => removeWordStudyStorage(unavailable, 'key')).not.toThrow();
  });
});
