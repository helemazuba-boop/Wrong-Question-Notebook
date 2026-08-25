import type { NoteObservationAction, NoteStudyMode } from './note-study-v1';

export interface PendingWebNoteObservation {
  request_id: string;
  session_id: string;
  sequence: number;
  item_id: string;
  action: Extract<
    NoteObservationAction,
    'opened' | 'read_completed' | 'skipped'
  >;
  mode: NoteStudyMode;
  occurred_at: string;
}

export type PendingNoteObservationDisposition =
  'retry' | 'already_applied' | 'invalid_gap';

export function noteStudyRetryDelayMs(failureCount: number): number {
  const boundedFailureCount = Math.max(1, Math.floor(failureCount));
  return Math.min(60_000, 5_000 * 2 ** Math.min(boundedFailureCount - 1, 4));
}

export function createWebNoteRequestId(prefix = 'webnote'): string {
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replaceAll('-', '')
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export function pendingNoteObservationStorageKey(sessionId: string): string {
  return `wqn:note-study:pending:${sessionId}`;
}

export function pendingNoteSessionStorageKey(): string {
  return 'wqn:note-study:last-session';
}

export function readNoteStudyStorage(
  storage: Storage,
  key: string
): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeNoteStudyStorage(
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

export function removeNoteStudyStorage(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // The server remains canonical when browser storage is unavailable.
  }
}

export function parsePendingWebNoteObservation(
  value: string | null,
  expectedSessionId: string
): PendingWebNoteObservation | null {
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
      !['opened', 'read_completed', 'skipped'].includes(parsed.action) ||
      !['sequential', 'recent'].includes(String(parsed.mode || '')) ||
      typeof parsed.occurred_at !== 'string' ||
      Number.isNaN(Date.parse(parsed.occurred_at))
    ) {
      return null;
    }
    return parsed as unknown as PendingWebNoteObservation;
  } catch {
    return null;
  }
}

export function dispositionForPendingNoteObservation(
  serverNextSequence: number,
  pending: PendingWebNoteObservation
): PendingNoteObservationDisposition {
  if (pending.sequence < serverNextSequence) return 'already_applied';
  if (pending.sequence === serverNextSequence) return 'retry';
  return 'invalid_gap';
}
