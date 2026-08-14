import { describe, expect, it } from 'vitest';
import {
  createWebNoteRequestId,
  dispositionForPendingNoteObservation,
  parsePendingWebNoteObservation,
  readNoteStudyStorage,
  removeNoteStudyStorage,
  writeNoteStudyStorage,
  type PendingWebNoteObservation,
} from '../note-study-client';

const SESSION_ID = '88888888-8888-4888-8888-888888888888';

function pending(
  overrides: Partial<PendingWebNoteObservation> = {}
): PendingWebNoteObservation {
  return {
    request_id: 'webnote_observation_1234567890',
    session_id: SESSION_ID,
    sequence: 3,
    item_id: '33333333-3333-4333-8333-333333333333',
    action: 'read_completed',
    mode: 'sequential',
    occurred_at: '2026-08-02T04:00:00.000Z',
    ...overrides,
  };
}

describe('Web Note reading pending observation recovery', () => {
  it('generates protocol-compatible idempotency keys', () => {
    const requestId = createWebNoteRequestId('note_read');
    expect(requestId.length).toBeGreaterThanOrEqual(16);
    expect(requestId.length).toBeLessThanOrEqual(64);
    expect(requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts only terminal Web reading actions for the expected session', () => {
    for (const action of ['opened', 'read_completed', 'skipped'] as const) {
      expect(
        parsePendingWebNoteObservation(
          JSON.stringify(pending({ action })),
          SESSION_ID
        )
      ).toMatchObject({ action, session_id: SESSION_ID });
    }
    expect(
      parsePendingWebNoteObservation(
        JSON.stringify({ ...pending(), action: 'session_paused' }),
        SESSION_ID
      )
    ).toBeNull();
    expect(
      parsePendingWebNoteObservation(
        JSON.stringify(pending()),
        '99999999-9999-4999-8999-999999999999'
      )
    ).toBeNull();
  });

  it('retries only the exact server sequence', () => {
    const observation = pending();
    expect(dispositionForPendingNoteObservation(3, observation)).toBe('retry');
    expect(dispositionForPendingNoteObservation(4, observation)).toBe(
      'already_applied'
    );
    expect(dispositionForPendingNoteObservation(2, observation)).toBe(
      'invalid_gap'
    );
  });

  it('rejects malformed payloads and degrades safely without storage', () => {
    expect(parsePendingWebNoteObservation('{', SESSION_ID)).toBeNull();
    expect(
      parsePendingWebNoteObservation(
        JSON.stringify(pending({ sequence: 1.5 })),
        SESSION_ID
      )
    ).toBeNull();

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
    expect(readNoteStudyStorage(unavailable, 'key')).toBeNull();
    expect(writeNoteStudyStorage(unavailable, 'key', 'value')).toBe(false);
    expect(() => removeNoteStudyStorage(unavailable, 'key')).not.toThrow();
  });
});
