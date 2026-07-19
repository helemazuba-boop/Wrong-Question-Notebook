import { createHmac, timingSafeEqual } from 'crypto';

export const INTERNAL_REQUEST_MAX_SKEW_MS = 30_000;

export function signInternalRequest(
  secret: string,
  timestamp: string,
  body: string
): string {
  return createHmac('sha256', secret)
    .update(timestamp)
    .update('\n')
    .update(body)
    .digest('hex');
}

export function verifyInternalRequest(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  if (!/^[0-9]{13}$/.test(input.timestamp)) return false;
  if (!/^[0-9a-f]{64}$/.test(input.signature)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (
    Math.abs(nowMs - Number(input.timestamp)) > INTERNAL_REQUEST_MAX_SKEW_MS
  ) {
    return false;
  }
  const expected = signInternalRequest(
    input.secret,
    input.timestamp,
    input.body
  );
  return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
}
