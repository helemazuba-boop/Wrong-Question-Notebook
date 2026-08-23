import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { fingerprintDeviceControlRequest } from './device-control-v3-idempotency';
import { logger } from './logger';
import {
  ensureWordPackForDeck,
  loadVisibleWordPackDecks,
  loadVisibleWordPackDecksByIds,
} from './word-packs';
import {
  orderWordStudyCandidates,
  type CandidateProgressStatus,
  type WordStudyCandidate,
} from './word-study-ordering';
import {
  candidatePolicyVersionForOrdering,
  semanticsForWordMode,
  WORD_CANDIDATE_PAGE_SIZE,
  wordCandidatePageDataSchema,
  wordObservationDataSchema,
  wordStudyOrderingSchema,
  wordStudySessionDataSchema,
  type WordCandidatePageData,
  type WordCandidatePageRequest,
  type CreateWordStudySessionRequest,
  type WordObservationRequest,
  type WordSkipObservationRequest,
  type WordStudySessionData,
} from './word-study-v1';

const CANDIDATE_PAGE_SIZE = 500;
const MAX_SESSION_CANDIDATES = 500;

type StudySessionTransportRow = Pick<
  Database['public']['Tables']['study_sessions']['Row'],
  | 'id'
  | 'domain'
  | 'mode'
  | 'purpose'
  | 'ordering'
  | 'seed'
  | 'scope'
  | 'optional_count'
  | 'next_sequence'
  | 'progress_revision'
  | 'snapshot'
  | 'candidate_items'
  | 'cursor'
  | 'has_more'
>;

export class WordStudyServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'WordStudyServiceError';
  }
}

function databaseError(action: string, error: unknown): never {
  logger.error('Word study database operation failed', error, {
    component: 'WordStudyV1',
    action,
  });
  throw new WordStudyServiceError(
    'WORD_STUDY_UNAVAILABLE',
    'Word study service unavailable',
    503,
    true
  );
}

function sessionDataFromRow(
  row: StudySessionTransportRow
): WordStudySessionData {
  const candidateItems = Array.isArray(row.candidate_items)
    ? row.candidate_items.slice(0, WORD_CANDIDATE_PAGE_SIZE)
    : row.candidate_items;
  const ordering = wordStudyOrderingSchema.parse(row.ordering);
  return wordStudySessionDataSchema.parse({
    session_id: row.id,
    domain: row.domain,
    mode: row.mode,
    purpose: row.purpose,
    ordering,
    candidate_policy_version: candidatePolicyVersionForOrdering(ordering),
    seed: row.seed,
    scope: row.scope,
    optional_count: row.optional_count,
    next_sequence: Number(row.next_sequence),
    progress_revision: Number(row.progress_revision || 0),
    snapshot: row.snapshot,
    items: candidateItems,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    has_more: Boolean(row.has_more),
  });
}

async function loadExistingSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  deviceId: string | null,
  requestId: string,
  expectedFingerprint: string
): Promise<WordStudySessionData | null> {
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
    throw new WordStudyServiceError(
      'REQUEST_ID_REUSED',
      'Request ID was already used for another session request',
      409
    );
  }
  return data ? sessionDataFromRow(data) : null;
}

function normalizeStatus(value: unknown): CandidateProgressStatus {
  return value === 'learning' || value === 'review' || value === 'mastered'
    ? value
    : 'new';
}

async function collectCandidates(
  supabase: SupabaseClient<Database>,
  userId: string,
  decks: Array<{ id: string }>,
  ordering: 'sequential' | 'guided_random_v1' | 'lexicographic',
  seed: string,
  includeMastered: boolean,
  outputLimit: number,
  nowMs: number
): Promise<{ candidates: WordStudyCandidate[]; eligibleCount: number }> {
  let pool: WordStudyCandidate[] = [];
  let eligibleCount = 0;
  const deckOrderById = new Map(decks.map((deck, index) => [deck.id, index]));
  const deckIds = decks.map(deck => deck.id);
  if (deckIds.length === 0) return { candidates: pool, eligibleCount };

  for (let offset = 0; ; offset += CANDIDATE_PAGE_SIZE) {
    // Progress is a user-scoped one-to-one projection of each entry. Fetch it
    // through the relationship in the same paginated query rather than doing
    // one progress query per entry page (or per 100 UUIDs).
    const { data: entries, error } = await supabase
      .from('word_entries')
      .select(
        'id, deck_id, normalized_word, sort_index, word_progress(status, due_at)'
      )
      .in('deck_id', deckIds)
      .eq('word_progress.user_id', userId)
      .order('deck_id', { ascending: true })
      .order('sort_index', { ascending: true })
      .order('normalized_word', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + CANDIDATE_PAGE_SIZE - 1);
    if (error) databaseError('collectCandidates.entries', error);
    if (!entries?.length) break;

    const pageCandidates: WordStudyCandidate[] = [];
    for (const entry of entries as any[]) {
      const progress = Array.isArray(entry.word_progress)
        ? entry.word_progress[0]
        : entry.word_progress;
      const status = normalizeStatus(progress?.status);
      if (!includeMastered && status === 'mastered') continue;
      eligibleCount += 1;
      pageCandidates.push({
        item_id: entry.id,
        deck_id: entry.deck_id,
        deck_order: deckOrderById.get(entry.deck_id) ?? Number.MAX_SAFE_INTEGER,
        sort_index: Number(entry.sort_index || 0),
        normalized_word: entry.normalized_word || '',
        status,
        due_at: progress?.due_at || null,
      });
    }

    // Keep only the best bounded prefix after each database page. Random
    // therefore considers the complete scope without retaining it all.
    pool = mergeWordStudyCandidatePage(
      pool,
      pageCandidates,
      ordering,
      seed,
      nowMs,
      outputLimit
    );

    if (entries.length < CANDIDATE_PAGE_SIZE) break;
  }

  return { candidates: pool, eligibleCount };
}

export function mergeWordStudyCandidatePage(
  pool: readonly WordStudyCandidate[],
  pageCandidates: readonly WordStudyCandidate[],
  ordering: 'sequential' | 'guided_random_v1' | 'lexicographic',
  seed: string,
  nowMs: number,
  outputLimit: number
): WordStudyCandidate[] {
  return orderWordStudyCandidates(
    [...pool, ...pageCandidates],
    ordering,
    seed,
    nowMs
  ).slice(0, outputLimit);
}

export async function createWordStudySession(
  supabase: SupabaseClient<Database>,
  userId: string,
  deviceId: string | null,
  input: CreateWordStudySessionRequest
): Promise<WordStudySessionData> {
  const startedAt = Date.now();
  const requestFingerprint = fingerprintDeviceControlRequest(input);
  const existing = await loadExistingSession(
    supabase,
    userId,
    deviceId,
    input.request_id,
    requestFingerprint
  );
  const existingLookupAt = Date.now();
  if (existing) {
    logger.info('Word study session replayed', {
      component: 'WordStudyV1',
      action: 'createWordStudySession.replay',
      requestId: input.request_id,
      elapsedMs: existingLookupAt - startedAt,
    });
    return existing;
  }

  const semantics = semanticsForWordMode(input.mode);
  const seed = input.seed || randomBytes(16).toString('hex');
  const visibleDecks = input.scope.deck_ids.length
    ? await loadVisibleWordPackDecksByIds(
        supabase,
        userId,
        input.scope.deck_ids
      )
    : await loadVisibleWordPackDecks(supabase, userId);
  const visibleById = new Map(visibleDecks.map(deck => [deck.id, deck]));
  const selectedDecks = input.scope.deck_ids.length
    ? input.scope.deck_ids.map(deckId => visibleById.get(deckId))
    : visibleDecks.slice(0, 32);
  if (selectedDecks.some(deck => !deck)) {
    throw new WordStudyServiceError(
      'WORD_SCOPE_NOT_VISIBLE',
      'Word study scope is not visible',
      404
    );
  }
  const decks = selectedDecks.filter(
    (deck): deck is (typeof visibleDecks)[number] => Boolean(deck)
  );
  const decksLoadedAt = Date.now();
  // Sequential and dictionary are explicit browse choices and therefore show
  // the complete scope.  Only guided random may omit mastered words unless
  // the caller explicitly includes them.
  const includeMastered =
    input.mode === 'random' ? input.scope.include_mastered : true;
  const scope = {
    deck_ids: decks.map(deck => deck.id),
    include_mastered: includeMastered,
  };
  const outputLimit = input.optional_count ?? MAX_SESSION_CANDIDATES;
  const nowMs = Date.now();

  const snapshot: Array<{
    deck_id: string;
    content_revision: number;
    pack_revision: number;
    sha256: string;
  }> = [];
  for (const deck of decks) {
    const pack = await ensureWordPackForDeck(supabase, deck);
    snapshot.push({
      deck_id: deck.id,
      content_revision: Number(deck.revision),
      pack_revision: Number(pack.revision),
      sha256: pack.sha256,
    });
  }
  const packsReadyAt = Date.now();

  const { data: progressChange, error: progressChangeError } = await supabase
    .from('word_change_log')
    .select('sequence')
    .eq('user_id', userId)
    .eq('entity_kind', 'progress')
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (progressChangeError) {
    databaseError(
      'createWordStudySession.progressRevision',
      progressChangeError
    );
  }
  const progressRevision = Number(progressChange?.sequence || 0);
  if (!Number.isSafeInteger(progressRevision) || progressRevision < 0) {
    throw new WordStudyServiceError(
      'WORD_PROGRESS_REVISION_INVALID',
      'Word progress revision is outside the protocol range',
      503,
      true
    );
  }

  const { candidates, eligibleCount } = await collectCandidates(
    supabase,
    userId,
    decks,
    semantics.ordering,
    seed,
    includeMastered,
    outputLimit,
    nowMs
  );
  const candidatesReadyAt = Date.now();

  const allCandidateItems = candidates.map((candidate, ordinal) => ({
    item_id: candidate.item_id,
    deck_id: candidate.deck_id,
    ordinal,
  }));
  const firstPage = allCandidateItems.slice(0, WORD_CANDIDATE_PAGE_SIZE);
  const cursor = String(firstPage.length);
  const { data, error } = await supabase.rpc('create_word_study_session_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_domain: 'word',
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
      throw new WordStudyServiceError(
        'REQUEST_ID_REUSED',
        'Request ID was already used for another session request',
        409
      );
    }
    if (message.includes('STUDY_PACK_CHANGED')) {
      throw new WordStudyServiceError(
        'PACK_REVISION_CHANGED',
        'Word pack changed while the session was created',
        409,
        true
      );
    }
    databaseError('createWordStudySession', error);
  }
  const readyAt = Date.now();
  logger.info('Word study session prepared', {
    component: 'WordStudyV1',
    action: 'createWordStudySession.ready',
    requestId: input.request_id,
    elapsedMs: readyAt - startedAt,
    existingLookupMs: existingLookupAt - startedAt,
    deckLookupMs: decksLoadedAt - existingLookupAt,
    packSnapshotMs: packsReadyAt - decksLoadedAt,
    candidateScanMs: candidatesReadyAt - packsReadyAt,
    persistMs: readyAt - candidatesReadyAt,
    deckCount: decks.length,
    eligibleCount,
    candidateCount: allCandidateItems.length,
  });
  return sessionDataFromRow(data);
}

export async function loadWordStudyCandidatePage(
  supabase: SupabaseClient<Database>,
  userId: string,
  deviceId: string | null,
  sessionId: string,
  input: WordCandidatePageRequest
): Promise<WordCandidatePageData> {
  const cursor = Number(input.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new WordStudyServiceError(
      'INVALID_CURSOR',
      'Candidate cursor is invalid',
      400
    );
  }

  let sessionQuery = supabase
    .from('study_sessions')
    .select(
      'id, ordering, seed, snapshot, progress_revision, candidate_items, candidate_count, status, expires_at'
    )
    .eq('id', sessionId)
    .eq('user_id', userId);
  sessionQuery = deviceId
    ? sessionQuery.eq('device_id', deviceId)
    : sessionQuery.is('device_id', null);
  const { data: session, error: sessionError } =
    await sessionQuery.maybeSingle();
  if (sessionError)
    databaseError('loadWordStudyCandidatePage.session', sessionError);
  if (!session) {
    throw new WordStudyServiceError(
      'SESSION_NOT_FOUND',
      'Word study session was not found',
      404
    );
  }
  if (!isWordStudySessionSnapshotReadable(session.status, session.expires_at)) {
    throw new WordStudyServiceError(
      'SESSION_NOT_ACTIVE',
      'Word study session is not active',
      409
    );
  }

  const candidateCount = Number(session.candidate_count || 0);
  if (!Number.isSafeInteger(candidateCount) || cursor > candidateCount) {
    throw new WordStudyServiceError(
      'INVALID_CURSOR',
      'Candidate cursor is outside the session snapshot',
      400
    );
  }
  const limit = input.limit ?? WORD_CANDIDATE_PAGE_SIZE;
  if (!Array.isArray(session.candidate_items)) {
    throw new WordStudyServiceError(
      'WORD_SESSION_SNAPSHOT_INCOMPLETE',
      'Word study candidate snapshot is invalid',
      409,
      false
    );
  }
  const items = session.candidate_items
    .slice(cursor, cursor + limit)
    .map((item: any) => ({
      item_id: item.item_id,
      deck_id: item.deck_id,
      ordinal: Number(item.ordinal),
    }));
  if (
    items.some(
      (item: { ordinal: number }, index: number) =>
        !Number.isSafeInteger(item.ordinal) || item.ordinal !== cursor + index
    ) ||
    (cursor < candidateCount && items.length === 0)
  ) {
    throw new WordStudyServiceError(
      'WORD_SESSION_SNAPSHOT_INCOMPLETE',
      'Word study candidate snapshot is incomplete',
      409,
      false
    );
  }
  const nextCursor = cursor + items.length;
  const ordering = wordStudyOrderingSchema.parse(session.ordering);
  return wordCandidatePageDataSchema.parse({
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

export function isWordStudySessionSnapshotReadable(
  status: string,
  expiresAt: string,
  now = Date.now()
): boolean {
  return (
    (status === 'active' || status === 'paused' || status === 'abandoned') &&
    Date.parse(expiresAt) > now
  );
}

export async function recordWordStudyObservation(
  supabase: SupabaseClient<Database>,
  userId: string,
  deviceId: string | null,
  input: WordObservationRequest
) {
  const { data, error } = await supabase.rpc('record_study_observation_v1', {
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
  if (error) {
    const message = String(error.message || '');
    if (message.includes('STUDY_REQUEST_ID_REUSED')) {
      throw new WordStudyServiceError(
        'REQUEST_ID_REUSED',
        'Request ID was already used for another observation',
        409
      );
    }
    if (message.includes('STUDY_SEQUENCE_GAP')) {
      throw new WordStudyServiceError(
        'SEQUENCE_GAP',
        'An earlier observation is still pending',
        409,
        true
      );
    }
    if (message.includes('STUDY_SEQUENCE_ALREADY_APPLIED')) {
      throw new WordStudyServiceError(
        'SEQUENCE_ALREADY_APPLIED',
        'Observation sequence was already applied',
        409
      );
    }
    if (message.includes('STUDY_SESSION_NOT_ACTIVE')) {
      throw new WordStudyServiceError(
        'SESSION_NOT_ACTIVE',
        'Study session is not active',
        409
      );
    }
    if (message.includes('STUDY_ITEM_NOT_VISIBLE')) {
      throw new WordStudyServiceError(
        'ITEM_NOT_VISIBLE',
        'Study item is not visible',
        404
      );
    }
    if (message.includes('STUDY_ITEM_NOT_IN_SESSION')) {
      throw new WordStudyServiceError(
        'ITEM_NOT_IN_SESSION',
        'Study item does not belong to this session snapshot',
        409
      );
    }
    if (message.includes('STUDY_SESSION_ACTOR_MISMATCH')) {
      throw new WordStudyServiceError(
        'SESSION_ACTOR_MISMATCH',
        'Study session belongs to another actor',
        403
      );
    }
    if (message.includes('INVALID_STUDY_OBSERVATION')) {
      throw new WordStudyServiceError(
        'INVALID_REQUEST',
        'Word study observation failed input validation',
        400
      );
    }
    databaseError('recordWordStudyObservation', error);
  }

  const parsed = wordObservationDataSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('Word study RPC returned an invalid result', parsed.error, {
      component: 'WordStudyV1',
      action: 'recordWordStudyObservation.parse',
    });
    throw new WordStudyServiceError(
      'INVALID_STUDY_RESULT',
      'Word study service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
}

export async function skipWordStudyObservation(
  supabase: SupabaseClient<Database>,
  userId: string,
  deviceId: string | null,
  input: WordSkipObservationRequest
) {
  const { data, error } = await supabase.rpc('skip_study_observation_v1', {
    p_user_id: userId,
    p_device_id: deviceId,
    p_request_id: input.request_id,
    p_session_id: input.session_id,
    p_sequence: input.sequence,
    p_item_id: input.item_id,
    // Minimal Tombstone Contract: placeholders are legal; the SQL function
    // ignores action, derives mode from the locked session, and defaults
    // occurred_at to server time. The generated RPC types still describe the
    // unchanged text/timestamptz signature, hence the targeted null casts.
    p_action: (input.action ?? null) as unknown as string,
    p_mode: (input.mode ?? null) as unknown as string,
    p_occurred_at: (input.occurred_at ?? null) as unknown as string,
  });
  if (error) {
    const message = String(error.message || '');
    if (message.includes('STUDY_REQUEST_ID_REUSED')) {
      throw new WordStudyServiceError(
        'REQUEST_ID_REUSED',
        'Request ID was already used for another observation',
        409
      );
    }
    if (message.includes('STUDY_SEQUENCE_GAP')) {
      throw new WordStudyServiceError(
        'SEQUENCE_GAP',
        'An earlier observation is still pending',
        409,
        true
      );
    }
    if (message.includes('STUDY_SEQUENCE_ALREADY_APPLIED')) {
      throw new WordStudyServiceError(
        'SEQUENCE_ALREADY_APPLIED',
        'Observation sequence was already applied',
        409
      );
    }
    if (message.includes('STUDY_SESSION_NOT_ACTIVE')) {
      throw new WordStudyServiceError(
        'SESSION_NOT_ACTIVE',
        'Study session is not active',
        409
      );
    }
    // Defensive parity with the record path: the tombstone itself never
    // raises these, but a future SQL drift must not degrade into a 503
    // "server unavailable" and get misclassified as transient.
    if (message.includes('STUDY_ITEM_NOT_VISIBLE')) {
      throw new WordStudyServiceError(
        'ITEM_NOT_VISIBLE',
        'Study item is not visible',
        404
      );
    }
    if (message.includes('STUDY_ITEM_NOT_IN_SESSION')) {
      throw new WordStudyServiceError(
        'ITEM_NOT_IN_SESSION',
        'Study item does not belong to this session snapshot',
        409
      );
    }
    if (message.includes('STUDY_SESSION_ACTOR_MISMATCH')) {
      throw new WordStudyServiceError(
        'SESSION_ACTOR_MISMATCH',
        'Study session belongs to another actor',
        403
      );
    }
    if (message.includes('INVALID_STUDY_OBSERVATION')) {
      throw new WordStudyServiceError(
        'INVALID_REQUEST',
        'Word study skip failed input validation',
        400
      );
    }
    databaseError('skipWordStudyObservation', error);
  }

  const parsed = wordObservationDataSchema.safeParse(data);
  if (!parsed.success) {
    logger.error(
      'Word study skip RPC returned an invalid result',
      parsed.error,
      {
        component: 'WordStudyV1',
        action: 'skipWordStudyObservation.parse',
      }
    );
    throw new WordStudyServiceError(
      'INVALID_STUDY_RESULT',
      'Word study service returned invalid data',
      503,
      true
    );
  }
  return parsed.data;
}
