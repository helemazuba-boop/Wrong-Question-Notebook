/**
 * Centralized Supabase utilities
 * Consolidates service client creation and common database operations
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { ERROR_MESSAGES } from './constants';
import { getSupabaseServerEnvironment } from './supabase-server-config';
import type { Database } from '@/lib/database.types';

// =====================================================
// Service Client Creation
// =====================================================

/**
 * Create service role client for admin operations
 * This bypasses RLS (Row Level Security) policies
 */
export function createServiceClient() {
  const environment = getSupabaseServerEnvironment();

  return createSupabaseClient<Database>(
    environment.url,
    environment.secretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

// =====================================================
// Database Operation Helpers
// =====================================================

/**
 * Generic function to handle database operations with error handling
 */
export async function handleDatabaseOperation<T>(
  operation: () => Promise<{ data: T | null; error: any }>
): Promise<{ data: T | null; error: string | null }> {
  try {
    const result = await operation();

    if (result.error) {
      console.error('Database operation error:', result.error);
      return {
        data: null,
        error: result.error.message || ERROR_MESSAGES.DATABASE_ERROR,
      };
    }

    return { data: result.data, error: null };
  } catch (error) {
    console.error('Unexpected database error:', error);
    return {
      data: null,
      error:
        error instanceof Error ? error.message : ERROR_MESSAGES.DATABASE_ERROR,
    };
  }
}

/**
 * Generic function to handle database operations that return arrays
 */
export async function handleDatabaseArrayOperation<T>(
  operation: () => Promise<{ data: T[] | null; error: any }>
): Promise<{ data: T[]; error: string | null }> {
  try {
    const result = await operation();

    if (result.error) {
      console.error('Database operation error:', result.error);
      return {
        data: [],
        error: result.error.message || ERROR_MESSAGES.DATABASE_ERROR,
      };
    }

    return { data: result.data || [], error: null };
  } catch (error) {
    console.error('Unexpected database error:', error);
    return {
      data: [],
      error:
        error instanceof Error ? error.message : ERROR_MESSAGES.DATABASE_ERROR,
    };
  }
}

/**
 * Generic function to handle database operations that return counts
 */
export async function handleDatabaseCountOperation(
  operation: () => Promise<{ count: number | null; error: any }>
): Promise<{ count: number; error: string | null }> {
  try {
    const result = await operation();

    if (result.error) {
      console.error('Database count operation error:', result.error);
      return {
        count: 0,
        error: result.error.message || ERROR_MESSAGES.DATABASE_ERROR,
      };
    }

    return { count: result.count || 0, error: null };
  } catch (error) {
    console.error('Unexpected database count error:', error);
    return {
      count: 0,
      error:
        error instanceof Error ? error.message : ERROR_MESSAGES.DATABASE_ERROR,
    };
  }
}

// =====================================================
// Retryable Auth Failure Helpers
// =====================================================

/**
 * PostgREST codes meaning "this session token was unusable right now" rather
 * than "this caller may not read this row": they are raised before a policy
 * is ever evaluated.
 *
 * `PGRST303` ("JWT issued at future") is the one observed in production: the
 * token GoTrue handed out carried an `iat` that PostgREST had not reached
 * yet. The burst is sub-second wide -- the request logged one millisecond
 * later against the same URL succeeded -- but anything that reads it as a
 * denial serves a user-visible failure out of that instant.
 */
const RETRYABLE_AUTH_ERROR_CODES = new Set(['PGRST301', 'PGRST303']);

/**
 * True when `error` is a PostgREST rejection of the caller's session token
 * that is expected to clear on its own.
 */
export function isRetryableAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_AUTH_ERROR_CODES.has(code);
}

/**
 * Run a Supabase query, retrying once if it failed with a retryable auth
 * error. The second attempt still returns its own result, so a caller that
 * needs to distinguish "denied" from "unavailable" can do so unchanged.
 */
export async function retryOnAuthFailure<T = any>(
  query: () => Promise<T>,
  delayMs = 120
): Promise<T> {
  const first = await query();
  const error = (first as { error?: unknown } | null | undefined)?.error;
  if (!isRetryableAuthError(error)) {
    return first;
  }

  await new Promise(resolve => setTimeout(resolve, delayMs));
  return query();
}

/**
 * Wrap a session-token rejection as a throwable `Error`, preserving the
 * PostgREST code so callers can still tell the two apart.
 *
 * Callers throw instead of returning their "not found" sentinel because the
 * page-level loaders memoise with `unstable_cache`: returning the sentinel
 * would make one sub-second blip authoritative for the whole revalidate
 * window, which is what turned it into a failure the user could not reload
 * away. A thrown error caches nothing and retries on the next request.
 */
export function toAuthUnavailableError(error: unknown): Error {
  const detail =
    error instanceof Error
      ? error.message
      : String(
          (error as { message?: unknown } | null | undefined)?.message ?? error
        );
  const wrapped = new Error(`Supabase session token rejected: ${detail}`);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') {
    (wrapped as Error & { code?: string }).code = code;
  }
  return wrapped;
}

// =====================================================
// Query Building Helpers
// =====================================================

/**
 * Build pagination parameters for database queries
 */
export function buildPaginationParams(
  limit: number = 50,
  offset: number = 0
): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(limit, 1), 1000), // Clamp between 1 and 1000
    offset: Math.max(offset, 0), // Ensure non-negative
  };
}

/**
 * Build ordering parameters for database queries
 */
export function buildOrderParams(
  column: string,
  ascending: boolean = true
): { column: string; ascending: boolean } {
  return {
    column,
    ascending,
  };
}

/**
 * Build date range filter for queries
 */
export function buildDateRangeFilter(
  startDate?: Date,
  endDate?: Date
): Record<string, string> {
  const filter: Record<string, string> = {};

  if (startDate) {
    filter.gte = startDate.toISOString();
  }

  if (endDate) {
    filter.lte = endDate.toISOString();
  }

  return filter;
}

// =====================================================
// User Role Helpers
// =====================================================

/**
 * Check if a user role has admin privileges
 */
export function isAdminRole(role: string): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * Check if a user role has super admin privileges
 */
export function isSuperAdminRole(role: string): boolean {
  return role === 'super_admin';
}

/**
 * Check if a user role has moderator privileges
 */
export function isModeratorRole(role: string): boolean {
  return role === 'moderator' || role === 'admin' || role === 'super_admin';
}

// =====================================================
// Validation Helpers
// =====================================================

/**
 * Validate user ID format
 */
export function isValidUserId(userId: string): boolean {
  // UUID v4 format validation
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(userId);
}

/**
 * Validate resource ID format
 */
export function isValidResourceId(resourceId: string): boolean {
  return isValidUserId(resourceId); // Same format as user ID
}

// =====================================================
// Transaction Helpers
// =====================================================

/**
 * Execute multiple database operations in a transaction-like manner
 * Note: This is a simplified version. For true transactions, consider using
 * Supabase's transaction support or database-level transactions.
 */
export async function executeDatabaseTransaction<T>(
  operations: Array<() => Promise<{ data: T | null; error: any }>>,
  rollbackOperation?: () => Promise<void>
): Promise<{ data: T[] | null; error: string | null }> {
  const results: T[] = [];

  try {
    for (const operation of operations) {
      const result = await operation();

      if (result.error) {
        // If rollback operation is provided, execute it
        if (rollbackOperation) {
          await rollbackOperation();
        }

        return {
          data: null,
          error: result.error.message || ERROR_MESSAGES.DATABASE_ERROR,
        };
      }

      if (result.data) {
        results.push(result.data);
      }
    }

    return { data: results, error: null };
  } catch (error) {
    console.error('Transaction error:', error);
    return {
      data: null,
      error:
        error instanceof Error ? error.message : ERROR_MESSAGES.DATABASE_ERROR,
    };
  }
}

// =====================================================
// Cache Helpers
// =====================================================

/**
 * Generate cache key for database queries
 */
export function generateCacheKey(
  prefix: string,
  params: Record<string, any>
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce(
      (result, key) => {
        result[key] = params[key];
        return result;
      },
      {} as Record<string, any>
    );

  return `${prefix}:${JSON.stringify(sortedParams)}`;
}

/**
 * Parse cache key back to parameters
 */
export function parseCacheKey(cacheKey: string): {
  prefix: string;
  params: Record<string, any>;
} {
  const [prefix, paramsString] = cacheKey.split(':');
  const params = paramsString ? JSON.parse(paramsString) : {};

  return { prefix, params };
}
