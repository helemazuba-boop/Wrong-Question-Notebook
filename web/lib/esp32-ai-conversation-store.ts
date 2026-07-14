// esp32-ai-conversation-store.ts
//
// Cloud-side source of truth for STD/PRO voice-AI conversation history.
// The device sends only conversation_id + tier (+ audio); the cloud loads
// prior turns here, prepends them to the LLM messages for multi-turn
// context, and appends each new (user, assistant) turn after the reply.
//
// Flash is untouched: it uses the realtime WebSocket proxy and manages its
// own context server-side (StepFun realtime session).
//
// Storage: Supabase table `esp32_ai_conversations` (one row per
// conversation, turns as a jsonb array). A server-side in-memory Map caches
// the active conversation so repeated turns in one visit don't hit Postgres
// each time; old conversations fall through to Supabase on the rare revisit.
//
// Single-writer assumption: one device, sequential PTT turns. The
// load-merge-upsert is not safe under concurrent writers for the same
// conversation_id, which is fine for this use case.

import { randomUUID } from 'node:crypto';

import { createServiceClient } from './supabase-utils';
import { logger } from './logger';

export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface CachedConversation {
  turns: AiTurn[];
  expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min covers an active visit
const MAX_STORED_TURNS = 50; // cap the persisted history
const MAX_CONTEXT_TURNS = 10; // cap turns prepended to the LLM messages

const cache = new Map<string, CachedConversation>();

function cacheKey(userId: string, conversationId: string): string {
  return userId + ':' + conversationId;
}

function getCached(userId: string, conversationId: string): AiTurn[] | null {
  const entry = cache.get(cacheKey(userId, conversationId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(userId, conversationId));
    return null;
  }
  return entry.turns;
}

function setCached(
  userId: string,
  conversationId: string,
  turns: AiTurn[]
): void {
  cache.set(cacheKey(userId, conversationId), {
    turns,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function mintConversationId(): string {
  return randomUUID();
}

/**
 * Load the full stored turn history for a conversation. Returns [] on any
 * error so the chat path degrades to single-turn rather than failing the
 * whole request. Populates the cache on a Supabase hit.
 */
export async function loadTurns(
  userId: string,
  conversationId: string
): Promise<AiTurn[]> {
  const cached = getCached(userId, conversationId);
  if (cached) return cached;

  try {
    const supabase = createServiceClient();
    // `esp32_ai_conversations` is not in database.types.ts until the
    // migration is applied and types regenerated; cast to any until then.
    const table = (supabase as any).from('esp32_ai_conversations');
    const { data, error } = await table
      .select('turns')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (error) {
      logger.warn('esp32_ai_conversations load failed', {
        message: error.message,
        conversationId,
      });
      return [];
    }
    const turns = Array.isArray(data?.turns)
      ? (data.turns as AiTurn[]).filter(
          (t): t is AiTurn =>
            t &&
            (t.role === 'user' || t.role === 'assistant') &&
            typeof t.content === 'string'
        )
      : [];
    setCached(userId, conversationId, turns);
    return turns;
  } catch (err) {
    logger.warn('esp32_ai_conversations load threw', {
      err: String(err),
      conversationId,
    });
    return [];
  }
}

/**
 * The slice of prior turns to inject as LLM context: the most recent
 * MAX_CONTEXT_TURNS, oldest-first so they prepend naturally before the
 * current user transcript.
 */
export function contextTurnsForLlm(turns: AiTurn[]): AiTurn[] {
  return turns.slice(-MAX_CONTEXT_TURNS);
}

/**
 * Append a pair of (user, assistant) turns for a conversation, write-through
 * to the cache and Supabase. Capped at MAX_STORED_TURNS (oldest dropped).
 */
export async function appendTurns(
  userId: string,
  conversationId: string,
  tier: string,
  deviceId: string | null,
  newTurns: AiTurn[]
): Promise<void> {
  if (newTurns.length === 0) return;

  const existing = getCached(userId, conversationId) ?? [];
  const merged = [...existing, ...newTurns].slice(-MAX_STORED_TURNS);
  setCached(userId, conversationId, merged);

  try {
    const supabase = createServiceClient();
    const table = (supabase as any).from('esp32_ai_conversations');
    const lastTurn = newTurns[newTurns.length - 1];
    const { error } = await table.upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        device_id: deviceId ?? null,
        tier: tier || 'std',
        turns: JSON.parse(JSON.stringify(merged)),
        last_turn_at: lastTurn.created_at,
      },
      { onConflict: 'user_id,conversation_id' }
    );
    if (error) {
      logger.warn('esp32_ai_conversations append failed', {
        message: error.message,
        conversationId,
      });
    }
  } catch (err) {
    logger.warn('esp32_ai_conversations append threw', {
      err: String(err),
      conversationId,
    });
  }
}
