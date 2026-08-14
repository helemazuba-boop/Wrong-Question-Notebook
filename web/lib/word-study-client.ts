import type { WordObservationAction, WordStudyMode } from './word-study-v1';

export interface PendingWebWordObservation {
  request_id: string;
  session_id: string;
  sequence: number;
  item_id: string;
  action: WordObservationAction;
  mode: WordStudyMode;
  occurred_at: string;
}

export type PendingObservationDisposition =
  'retry' | 'already_applied' | 'invalid_gap';

export function createWebWordRequestId(prefix = 'webword'): string {
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replaceAll('-', '')
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export function pendingWordObservationStorageKey(sessionId: string): string {
  return `wqn:word-study:pending:${sessionId}`;
}

export function pendingWordSessionStorageKey(): string {
  return 'wqn:word-study:last-session';
}

export function readWordStudyStorage(
  storage: Storage,
  key: string
): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeWordStudyStorage(
  storage: Storage,
  key: string,
  value: string
): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeWordStudyStorage(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // The cloud remains canonical when browser storage is unavailable.
  }
}

export function parsePendingWebWordObservation(
  value: string | null,
  expectedSessionId: string
): PendingWebWordObservation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.request_id !== 'string' ||
      parsed.request_id.length < 16 ||
      parsed.session_id !== expectedSessionId ||
      typeof parsed.sequence !== 'number' ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 0 ||
      typeof parsed.item_id !== 'string' ||
      typeof parsed.action !== 'string' ||
      !['known', 'unknown', 'skipped', 'looked_up'].includes(parsed.action) ||
      !['sequential', 'random', 'dictionary'].includes(
        String(parsed.mode || '')
      ) ||
      typeof parsed.occurred_at !== 'string' ||
      Number.isNaN(Date.parse(parsed.occurred_at))
    ) {
      return null;
    }
    return parsed as unknown as PendingWebWordObservation;
  } catch {
    return null;
  }
}

export function dispositionForPendingObservation(
  serverNextSequence: number,
  pending: PendingWebWordObservation
): PendingObservationDisposition {
  if (pending.sequence < serverNextSequence) return 'already_applied';
  if (pending.sequence === serverNextSequence) return 'retry';
  return 'invalid_gap';
}
