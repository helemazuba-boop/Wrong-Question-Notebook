import { NextResponse } from 'next/server';
import { z } from 'zod';
import { normalizeWebWordStudyError } from './word-study-web';

export const webObservationSchema = z.strictObject({
  request_id: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  session_id: z.uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  item_id: z.uuid(),
  action: z.enum([
    'shown',
    'revealed',
    'known',
    'unknown',
    'skipped',
    'looked_up',
  ]),
  mode: z.enum(['sequential', 'random', 'dictionary']),
  occurred_at: z.string().datetime(),
});

export function webWordStudySuccess<T>(
  requestId: string,
  data: T,
  status = 200
) {
  return NextResponse.json(
    {
      ok: true as const,
      request_id: requestId,
      server_time_ms: Date.now(),
      data,
    },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function webWordStudyError(requestId: string, error: unknown) {
  const normalized = normalizeWebWordStudyError(error);
  return NextResponse.json(
    {
      ok: false as const,
      request_id: requestId,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    },
    {
      status: normalized.status,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

export function webWordStudyInvalidRequest(
  requestId: string,
  message = 'Invalid Word study request'
) {
  return NextResponse.json(
    {
      ok: false as const,
      request_id: requestId,
      error: {
        code: 'INVALID_REQUEST',
        message,
        retryable: false,
      },
    },
    { status: 400, headers: { 'Cache-Control': 'no-store' } }
  );
}
