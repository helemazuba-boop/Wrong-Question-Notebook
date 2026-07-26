import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fingerprintDeviceControlRequest } from './device-control-v3-idempotency';
import { logger } from './logger';
import { buildNotePack } from './note-packs';
import {
  orderNoteStudyCandidates,
  type NoteStudyCandidate,
  type NoteStudyOrderingKind,
} from './note-study-ordering';
import {
  candidatePolicyVersionForOrdering,
  semanticsForNoteMode,
  NOTE_CANDIDATE_PAGE_SIZE,
  noteCandidatePageDataSchema,
  noteObservationDataSchema,
  noteStudyOrderingSchema,
  noteStudySessionDataSchema,
  type NoteCandidatePageData,
  type NoteCandidatePageRequest,
  type CreateNoteStudySessionRequest,
  type NoteObservationRequest,
  type NoteStudySessionData,
} from './note-study-v1';

const CANDIDATE_SCAN_PAGE = 500;
const MAX_SESSION_CANDIDATES = 500;

export class NoteStudyServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'NoteStudyServiceError';
  }
}

function databaseError(action: string, error: unknown): never {
  logger.error('Note study database operation failed', error, {
    component: 'NoteStudyV1',
    action,
  });
  throw new NoteStudyServiceError(
    'NOTE_STUDY_UNAVAILABLE',
    'Note study service unavailable',
    503,
    true
  );
}

function sessionDataFromRow(row: any): NoteStudySessionData {
  const candidateItems = Array.isArray(row.candidate_items)
    ? row.candidate_items.slice(0, NOTE_CANDIDATE_PAGE_SIZE)
    : row.candidate_items;
  const ordering = noteStudyOrderingSchema.parse(row.ordering);
  return noteStudySessionDataSchema.parse({
    session_id: row.id,
    domain: row.domain,
    mode: row.mode,
    purpose: row.purpose,
    ordering,
    candidate_policy_version: candidatePolicyVersionForOrdering(ordering),
    seed: row.seed,
    scope: row.scope,
    ...(row.optional_count != null
      ? { optional_count: Number(row.optional_count) }
      : {}),
    next_sequence: Number(row.next_sequence),
    progress_revision: Number(row.progress_revision || 0),
    snapshot: row.snapshot,
    items: candidateItems,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    has_more: Boolean(row.has_more),
  });
}

async function loadExistingSession(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  requestId: string,
  expectedFingerprint: string
): Promise<NoteStudySessionData | null> {
  let query = supabase
    .from('study_sessions')
    .select(
      'id, domain, mode, purpose, ordering, seed, scope, optional_count, next_sequence, progress_revision, snapshot, candidate_items, cursor, has_more, create_fingerprint'
    )
    .eq('user_id', userId)
    .eq('create_request_id', requestId);
  query = deviceId
    ? query.eq('device_id', deviceId)
    : query.is('device_id', null);
  const { data, error } = await query.maybeSingle();
  if (error) databaseError('loadExistingSession', error);
  if (data && data.create_fingerprint !== expectedFingerprint) {
    throw new NoteStudyServiceError(
      'REQUEST_ID_REUSED',
      'Request ID was already used for another session request',
      409
    );
  }
  return data ? sessionDataFromRow(data) : null;
}

export function mergeNoteStudyCandidatePage(
  pool: readonly NoteStudyCandidate[],
  pageCandidates: readonly NoteStudyCandidate[],
  ordering: NoteStudyOrderingKind,
  outputLimit: number
): NoteStudyCandidate[] {
  return orderNoteStudyCandidates([...pool, ...pageCandidates], ordering).slice(
    0,
    outputLimit
  );
}

async function collectCandidates(
  supabase: SupabaseClient<any>,
  userId: string,
  notebooks: Array<{ id: string }>,
  ordering: NoteStudyOrderingKind,
  outputLimit: number
): Promise<NoteStudyCandidate[]> {
  let pool: NoteStudyCandidate[] = [];
  const orderById = new Map(notebooks.map((n, index) => [n.id, index]));
  const ids = notebooks.map(n => n.id);
  if (ids.length === 0) return pool;

  for (let offset = 0; ; offset += CANDIDATE_SCAN_PAGE) {
    const { data, error } = await supabase
      .from('notebook_notes')
      .select('id, notebook_id, sort_index, created_at')
      .in('notebook_id', ids)
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('notebook_id', { ascending: true })
      .order('sort_index', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + CANDIDATE_SCAN_PAGE - 1);
    if (error) databaseError('collectCandidates', error);
    if (!data?.length) break;

    // Read-state (last_opened_at) drives the least-recently-viewed ranking and
    // the device last-viewed label. Fetched per page and left-joined in memory
    // so never-viewed notes keep a null last_opened_at.
    const pageIds = (data as any[]).map(row => row.id);
    const readState = new Map<string, string | null>();
    const { data: readRows, error: readError } = await supabase
      .from('note_read_state')
      .select('note_id, last_opened_at')
      .eq('user_id', userId)
      .in('note_id', pageIds);
    if (readError) databaseError('collectCandidates.readState', readError);
    for (const row of (readRows || []) as any[]) {
      readState.set(row.note_id, row.last_opened_at ?? null);
    }

    const pageCandidates: NoteStudyCandidate[] = (data as any[]).map(row => ({
      item_id: row.id,
      notebook_id: row.notebook_id,
      notebook_order: orderById.get(row.notebook_id) ?? Number.MAX_SAFE_INTEGER,
      sort_index: Number(row.sort_index || 0),
      last_opened_at: readState.get(row.id) ?? null,
      created_at: row.created_at || '',
    }));
    pool = mergeNoteStudyCandidatePage(
      pool,
      pageCandidates,
      ordering,
      outputLimit
    );
    if (data.length < CANDIDATE_SCAN_PAGE) break;
  }
  return pool;
}

async function loadScopedNotebooks(
  supabase: SupabaseClient<any>,
  userId: string,
  notebookIds: string[]
): Promise<Array<{ id: string }>> {
  let query = supabase
    .from('notebooks')
    .select('id')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (notebookIds.length) query = query.in('id', notebookIds);
  const { data, error } = await query
    .order('id', { ascending: true })
    .limit(32);
  if (error) databaseError('loadScopedNotebooks', error);
  return (data || []) as Array<{ id: string }>;
}

async function progressRevisionForUser(
  supabase: SupabaseClient<any>,
  userId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('note_change_log')
    .select('change_seq')
    .eq('user_id', userId)
    .order('change_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) databaseError('progressRevisionForUser', error);
  return Number(data?.change_seq || 0);
}

export async function createNoteStudySession(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  input: CreateNoteStudySessionRequest
): Promise<NoteStudySessionData> {
  const requestFingerprint = fingerprintDeviceControlRequest(input);
  const existing = await loadExistingSession(
    supabase,
    userId,
    deviceId,
    input.request_id,
    requestFingerprint
  );
  if (existing) return existing;

  const semantics = semanticsForNoteMode(input.mode);
  const seed = input.seed || randomBytes(16).toString('hex');
  const requestedIds = input.scope.notebook_ids;
  const visibleNotebooks = await loadScopedNotebooks(
    supabase,
    userId,
    requestedIds
  );
  const visibleById = new Map(visibleNotebooks.map(n => [n.id, n]));
  const selected = requestedIds.length
    ? requestedIds.map(id => visibleById.get(id))
    : visibleNotebooks;
  if (selected.some(n => !n)) {
    throw new NoteStudyServiceError(
      'NOTE_SCOPE_NOT_VISIBLE',
      'Note study scope is not visible',
      404
    );
  }
  const notebooks = selected.filter((n): n is { id: string } => Boolean(n));
  const scope = {
    notebook_ids: notebooks.map(n => n.id),
    // v1 never studies archived content; the flag is retained for the wire.
    include_archived: false,
  };
  const outputLimit = input.optional_count ?? MAX_SESSION_CANDIDATES;

  const snapshot: Array<{
    notebook_id: string;
    content_revision: number;
    pack_revision: number;
    sha256: string;
  }> = [];
  for (const notebook of notebooks) {
    const pack = await buildNotePack(supabase, userId, notebook.id);
    snapshot.push({
      notebook_id: notebook.id,
      content_revision: pack.content_revision,
      pack_revision: pack.pack_revision,
      sha256: pack.sha256,
    });
  }

  const progressRevision = await progressRevisionForUser(supabase, userId);
  const candidates = await collectCandidates(
    supabase,
    userId,
    notebooks,
    semantics.ordering,
    outputLimit
  );
  const allCandidateItems = candidates.map((candidate, ordinal) => ({
    item_id: candidate.item_id,
    notebook_id: candidate.notebook_id,
    ordinal,
    last_opened_at: candidate.last_opened_at,
  }));
  const firstPage = allCandidateItems.slice(0, NOTE_CANDIDATE_PAGE_SIZE);
  const cursor = String(firstPage.length);

  const { data, error } = await supabase.rpc('create_note_study_session_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_mode: input.mode,
    p_purpose: semantics.purpose,
    p_ordering: semantics.ordering,
    p_scope: scope,
    p_optional_count: outputLimit,
    p_seed: seed,
    p_snapshot: snapshot,
    p_candidate_items: allCandidateItems,
    p_progress_revision: progressRevision,
    p_cursor: cursor,
    p_has_more: firstPage.length < allCandidateItems.length,
    p_create_request_id: input.request_id,
    p_create_fingerprint: requestFingerprint,
  });
  if (error) {
    const message = String(error.message || '');
    if (message.includes('STUDY_REQUEST_ID_REUSED')) {
      throw new NoteStudyServiceError(
        'REQUEST_ID_REUSED',
        'Request ID was already used for another session request',
        409
      );
    }
    if (message.includes('STUDY_PACK_CHANGED')) {
      throw new NoteStudyServiceError(
        'PACK_REVISION_CHANGED',
        'Notebook scope changed while the session was created',
        409,
        true
      );
    }
    databaseError('createNoteStudySession', error);
  }
  return sessionDataFromRow(data);
}

export function isNoteStudySessionSnapshotReadable(
  status: string,
  expiresAt: string,
  now = Date.now()
): boolean {
  return (
    (status === 'active' || status === 'paused' || status === 'abandoned') &&
    Date.parse(expiresAt) > now
  );
}

export async function loadNoteStudyCandidatePage(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  sessionId: string,
  input: NoteCandidatePageRequest
): Promise<NoteCandidatePageData> {
  const cursor = Number(input.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new NoteStudyServiceError(
      'INVALID_CURSOR',
      'Candidate cursor is invalid',
      400
    );
  }

  let sessionQuery = supabase
    .from('study_sessions')
    .select(
      'id, domain, ordering, seed, snapshot, progress_revision, candidate_items, candidate_count, status, expires_at'
    )
    .eq('id', sessionId)
    .eq('user_id', userId);
  sessionQuery = deviceId
    ? sessionQuery.eq('device_id', deviceId)
    : sessionQuery.is('device_id', null);
  const { data: session, error: sessionError } =
    await sessionQuery.maybeSingle();
  if (sessionError) databaseError('loadNoteStudyCandidatePage', sessionError);
  if (!session || session.domain !== 'note') {
    throw new NoteStudyServiceError(
      'SESSION_NOT_FOUND',
      'Note study session was not found',
      404
    );
  }
  if (!isNoteStudySessionSnapshotReadable(session.status, session.expires_at)) {
    throw new NoteStudyServiceError(
      'SESSION_NOT_ACTIVE',
      'Note study session is not active',
      409
    );
  }

  const candidateCount = Number(session.candidate_count || 0);
  if (!Number.isSafeInteger(candidateCount) || cursor > candidateCount) {
    throw new NoteStudyServiceError(
      'INVALID_CURSOR',
      'Candidate cursor is outside the session snapshot',
      400
    );
  }
  const limit = input.limit ?? NOTE_CANDIDATE_PAGE_SIZE;
  if (!Array.isArray(session.candidate_items)) {
    throw new NoteStudyServiceError(
      'NOTE_SESSION_SNAPSHOT_INCOMPLETE',
      'Note study candidate snapshot is invalid',
      409,
      false
    );
  }
  const items = session.candidate_items
    .slice(cursor, cursor + limit)
    .map((item: any) => ({
      item_id: item.item_id,
      notebook_id: item.notebook_id,
      ordinal: Number(item.ordinal),
      last_opened_at: item.last_opened_at ?? null,
    }));
  if (
    items.some(
      (item: { ordinal: number }, index: number) =>
        !Number.isSafeInteger(item.ordinal) || item.ordinal !== cursor + index
    ) ||
    (cursor < candidateCount && items.length === 0)
  ) {
    throw new NoteStudyServiceError(
      'NOTE_SESSION_SNAPSHOT_INCOMPLETE',
      'Note study candidate snapshot is incomplete',
      409,
      false
    );
  }
  const nextCursor = cursor + items.length;
  const ordering = noteStudyOrderingSchema.parse(session.ordering);
  return noteCandidatePageDataSchema.parse({
    session_id: session.id,
    ordering,
    candidate_policy_version: candidatePolicyVersionForOrdering(ordering),
    seed: session.seed,
    snapshot: session.snapshot,
    progress_revision: Number(session.progress_revision || 0),
    cursor: String(cursor),
    next_cursor: String(nextCursor),
    items,
    has_more: nextCursor < candidateCount,
  });
}

function mapObservationRpcError(
  action: string,
  error: { message?: string }
): never {
  const message = String(error.message || '');
  if (message.includes('STUDY_REQUEST_ID_REUSED')) {
    throw new NoteStudyServiceError(
      'REQUEST_ID_REUSED',
      'Request ID was already used for another observation',
      409
    );
  }
  if (message.includes('STUDY_SEQUENCE_GAP')) {
    throw new NoteStudyServiceError(
      'SEQUENCE_GAP',
      'An earlier observation is still pending',
      409,
      true
    );
  }
  if (message.includes('STUDY_SEQUENCE_ALREADY_APPLIED')) {
    throw new NoteStudyServiceError(
      'SEQUENCE_ALREADY_APPLIED',
      'Observation sequence was already applied',
      409
    );
  }
  if (message.includes('STUDY_SESSION_NOT_ACTIVE')) {
    throw new NoteStudyServiceError(
      'SESSION_NOT_ACTIVE',
      'Note study session is not active',
      409
    );
  }
  if (message.includes('STUDY_ITEM_NOT_VISIBLE')) {
    throw new NoteStudyServiceError(
      'ITEM_NOT_VISIBLE',
      'Note is not visible',
      404
    );
  }
  if (message.includes('STUDY_ITEM_NOT_IN_SESSION')) {
    throw new NoteStudyServiceError(
      'ITEM_NOT_IN_SESSION',
      'Note does not belong to this session snapshot',
      409
    );
  }
  if (message.includes('STUDY_SESSION_ACTOR_MISMATCH')) {
    throw new NoteStudyServiceError(
      'SESSION_ACTOR_MISMATCH',
      'Note study session belongs to another actor',
      403
    );
  }
  databaseError(action, error);
}

export async function recordNoteStudyObservation(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  input: NoteObservationRequest
) {
  const { data, error } = await supabase.rpc(
    'record_note_study_observation_v1',
    {
      p_user_id: userId,
      p_device_id: deviceId,
      p_request_id: input.request_id,
      p_session_id: input.session_id,
      p_sequence: input.sequence,
      p_item_id: input.item_id,
      p_action: input.action,
      p_mode: input.mode,
      p_occurred_at: input.occurred_at,
    }
  );
  if (error) mapObservationRpcError('recordNoteStudyObservation', error);

  const parsed = noteObservationDataSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('Note study RPC returned an invalid result', parsed.error, {
      component: 'NoteStudyV1',
      action: 'recordNoteStudyObservation.parse',
    });
    throw new NoteStudyServiceError(
      'INVALID_STUDY_RESULT',
      'Note study service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
}

export async function skipNoteStudyObservation(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  input: NoteObservationRequest
) {
  const { data, error } = await supabase.rpc('skip_note_study_observation_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_request_id: input.request_id,
    p_session_id: input.session_id,
    p_sequence: input.sequence,
    p_item_id: input.item_id,
    p_action: input.action,
    p_mode: input.mode,
    p_occurred_at: input.occurred_at,
  });
  if (error) mapObservationRpcError('skipNoteStudyObservation', error);

  const parsed = noteObservationDataSchema.safeParse(data);
  if (!parsed.success) {
    logger.error(
      'Note study skip RPC returned an invalid result',
      parsed.error,
      {
        component: 'NoteStudyV1',
        action: 'skipNoteStudyObservation.parse',
      }
    );
    throw new NoteStudyServiceError(
      'INVALID_STUDY_RESULT',
      'Note study service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
}
