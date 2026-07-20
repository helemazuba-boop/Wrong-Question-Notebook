import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
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
  wordObservationDataSchema,
  wordStudySessionDataSchema,
  type WordCandidatePageData,
  type WordCandidatePageRequest,
  type CreateWordStudySessionRequest,
  type WordObservationRequest,
  type WordStudySessionData,
} from './word-study-v1';

const CANDIDATE_PAGE_SIZE = 500;
const MAX_SESSION_CANDIDATES = 32 * 10_000;
const CANDIDATE_INSERT_BATCH_SIZE = 500;
export const WORD_PROGRESS_FILTER_BATCH_SIZE = 100;

export function chunkWordProgressIds(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += WORD_PROGRESS_FILTER_BATCH_SIZE
  ) {
    batches.push(ids.slice(offset, offset + WORD_PROGRESS_FILTER_BATCH_SIZE));
  }
  return batches;
}

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

function sessionDataFromRow(row: any): WordStudySessionData {
  return wordStudySessionDataSchema.parse({
    session_id: row.id,
    domain: row.domain,
    mode: row.mode,
    purpose: row.purpose,
    ordering: row.ordering,
    candidate_policy_version: candidatePolicyVersionForOrdering(row.ordering),
    seed: row.seed,
    scope: row.scope,
    optional_count: row.optional_count,
    next_sequence: Number(row.next_sequence),
    progress_revision: Number(row.progress_revision || 0),
    snapshot: row.snapshot,
    items: row.candidate_items,
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
): Promise<WordStudySessionData | null> {
  let query = supabase
    .from('study_sessions')
    .select(
      'id, domain, mode, purpose, ordering, seed, scope, optional_count, next_sequence, progress_revision, snapshot, candidate_items, cursor, has_more, create_fingerprint, candidates_ready, created_at'
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
  if (data && !data.candidates_ready) {
    const createdAt = Date.parse(String(data.created_at || ''));
    if (Number.isFinite(createdAt) && Date.now() - createdAt > 60_000) {
      const { error: cleanupError } = await supabase
        .from('study_sessions')
        .delete()
        .eq('id', data.id)
        .eq('candidates_ready', false);
      if (cleanupError) {
        databaseError('loadExistingSession.cleanupIncomplete', cleanupError);
      }
      return null;
    }
    throw new WordStudyServiceError(
      'WORD_SESSION_BUILDING',
      'Word study session is still being prepared',
      503,
      true
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
  supabase: SupabaseClient<any>,
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

  for (let deckOrder = 0; deckOrder < decks.length; deckOrder += 1) {
    const deck = decks[deckOrder];
    for (let offset = 0; ; offset += CANDIDATE_PAGE_SIZE) {
      const { data: entries, error } = await supabase
        .from('word_entries')
        .select('id, deck_id, normalized_word, sort_index')
        .eq('deck_id', deck.id)
        .order('sort_index', { ascending: true })
        .order('normalized_word', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + CANDIDATE_PAGE_SIZE - 1);
      if (error) databaseError('collectCandidates.entries', error);
      if (!entries?.length) break;

      const ids = entries.map((entry: any) => entry.id);
      const progressRows: any[] = [];
      // A 500-UUID PostgREST `in` filter produces a roughly 20KB request URL,
      // exceeding Node/Undici's header limit before the response can be read.
      // Fixed-size batches keep every request bounded while retaining the
      // explicit user_id filter required for shared/system word decks.
      for (const idBatch of chunkWordProgressIds(ids)) {
        const { data: batchRows, error: progressError } = await supabase
          .from('word_progress')
          .select('word_entry_id, status, due_at')
          .eq('user_id', userId)
          .in('word_entry_id', idBatch);
        if (progressError)
          databaseError('collectCandidates.progress', progressError);
        progressRows.push(...(batchRows || []));
      }
      const progressById = new Map(
        progressRows.map((progress: any) => [progress.word_entry_id, progress])
      );

      const pageCandidates: WordStudyCandidate[] = [];
      for (const entry of entries) {
        const progress: any = progressById.get(entry.id);
        const status = normalizeStatus(progress?.status);
        if (!includeMastered && status === 'mastered') continue;
        eligibleCount += 1;
        pageCandidates.push({
          item_id: entry.id,
          deck_id: entry.deck_id,
          deck_order: deckOrder,
          sort_index: Number(entry.sort_index || 0),
          normalized_word: entry.normalized_word || '',
          status,
          due_at: progress?.due_at || null,
        });
      }

      // Keep only the best bounded prefix after each database page. Random
      // therefore considers the complete scope without retaining it all.
      pool = orderWordStudyCandidates(
        [...pool, ...pageCandidates],
        ordering,
        seed,
        nowMs
      ).slice(0, outputLimit);

      if (entries.length < CANDIDATE_PAGE_SIZE) break;
    }
  }

  return { candidates: pool, eligibleCount };
}

export async function createWordStudySession(
  supabase: SupabaseClient<any>,
  userId: string,
  deviceId: string | null,
  input: CreateWordStudySessionRequest
): Promise<WordStudySessionData> {
  const requestFingerprint = fingerprintDeviceControlRequest(input);
  const existing = await loadExistingSession(
    supabase,
    userId,
    deviceId,
    input.request_id,
    requestFingerprint
  );
  if (existing) return existing;

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
  if (input.optional_count == null && eligibleCount > MAX_SESSION_CANDIDATES) {
    throw new WordStudyServiceError(
      'WORD_SCOPE_TOO_LARGE',
      'Word study scope exceeds the bounded session limit',
      413
    );
  }

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

  const allCandidateItems = candidates.map((candidate, ordinal) => ({
    item_id: candidate.item_id,
    deck_id: candidate.deck_id,
    ordinal,
  }));
  const firstPage = allCandidateItems.slice(0, WORD_CANDIDATE_PAGE_SIZE);
  const cursor = String(firstPage.length);
  const row = {
    user_id: userId,
    device_id: deviceId,
    domain: 'word',
    mode: input.mode,
    purpose: semantics.purpose,
    ordering: semantics.ordering,
    scope,
    optional_count: input.optional_count ?? null,
    seed,
    snapshot,
    candidate_ids: firstPage.map(item => item.item_id),
    candidate_items: firstPage,
    progress_revision: progressRevision,
    candidate_count: allCandidateItems.length,
    candidates_ready: false,
    next_sequence: 0,
    cursor,
    has_more: firstPage.length < allCandidateItems.length,
    create_request_id: input.request_id,
    create_fingerprint: requestFingerprint,
  };
  const { data, error } = await supabase
    .from('study_sessions')
    .insert(row)
    .select(
      'id, domain, mode, purpose, ordering, seed, scope, optional_count, next_sequence, progress_revision, snapshot, candidate_items, cursor, has_more, candidates_ready'
    )
    .single();
  if (error) {
    if (error.code === '23505') {
      const replay = await loadExistingSession(
        supabase,
        userId,
        deviceId,
        input.request_id,
        requestFingerprint
      );
      if (replay) return replay;
    }
    databaseError('createWordStudySession', error);
  }
  for (
    let offset = 0;
    offset < allCandidateItems.length;
    offset += CANDIDATE_INSERT_BATCH_SIZE
  ) {
    const candidateRows = allCandidateItems
      .slice(offset, offset + CANDIDATE_INSERT_BATCH_SIZE)
      .map(item => ({ session_id: data.id, ...item }));
    const { error: candidateError } = await supabase
      .from('study_session_candidates')
      .insert(candidateRows);
    if (candidateError) {
      await supabase.from('study_sessions').delete().eq('id', data.id);
      databaseError('createWordStudySession.candidates', candidateError);
    }
  }

  const { data: ready, error: readyError } = await supabase
    .from('study_sessions')
    .update({ candidates_ready: true })
    .eq('id', data.id)
    .eq('candidates_ready', false)
    .select(
      'id, domain, mode, purpose, ordering, seed, scope, optional_count, next_sequence, progress_revision, snapshot, candidate_items, cursor, has_more, candidates_ready'
    )
    .single();
  if (readyError) {
    await supabase.from('study_sessions').delete().eq('id', data.id);
    databaseError('createWordStudySession.ready', readyError);
  }
  return sessionDataFromRow(ready);
}

export async function loadWordStudyCandidatePage(
  supabase: SupabaseClient<any>,
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
      'id, ordering, seed, snapshot, progress_revision, candidate_count, candidates_ready, status'
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
  if (!session.candidates_ready) {
    throw new WordStudyServiceError(
      'WORD_SESSION_BUILDING',
      'Word study session is still being prepared',
      503,
      true
    );
  }
  if (session.status !== 'active' && session.status !== 'paused') {
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
  const { data: rows, error: candidateError } = await supabase
    .from('study_session_candidates')
    .select('item_id, deck_id, ordinal')
    .eq('session_id', sessionId)
    .gte('ordinal', cursor)
    .order('ordinal', { ascending: true })
    .limit(limit);
  if (candidateError) {
    databaseError('loadWordStudyCandidatePage.candidates', candidateError);
  }

  const items = (rows || []).map((item: any) => ({
    item_id: item.item_id,
    deck_id: item.deck_id,
    ordinal: Number(item.ordinal),
  }));
  if (
    items.some(
      (item, index) =>
        !Number.isSafeInteger(item.ordinal) || item.ordinal !== cursor + index
    ) ||
    (cursor < candidateCount && items.length === 0)
  ) {
    throw new WordStudyServiceError(
      'WORD_SESSION_SNAPSHOT_INCOMPLETE',
      'Word study candidate snapshot is incomplete',
      503,
      true
    );
  }
  const nextCursor = cursor + items.length;
  return {
    session_id: session.id,
    ordering: session.ordering,
    candidate_policy_version: candidatePolicyVersionForOrdering(
      session.ordering
    ),
    seed: session.seed,
    snapshot: session.snapshot,
    progress_revision: Number(session.progress_revision || 0),
    cursor: String(cursor),
    next_cursor: String(nextCursor),
    items,
    has_more: nextCursor < candidateCount,
  };
}

export async function recordWordStudyObservation(
  supabase: SupabaseClient<any>,
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
    if (message.includes('STUDY_SEQUENCE_OUT_OF_ORDER')) {
      throw new WordStudyServiceError(
        'SEQUENCE_OUT_OF_ORDER',
        'Observation sequence is out of order',
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
