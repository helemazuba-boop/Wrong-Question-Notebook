import { createHash } from 'crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function fingerprintDeviceControlRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function deterministicDeviceAttemptId(
  deviceId: string,
  requestId: string,
  resultIndex: number,
  problemId: string
): string {
  const bytes = createHash('sha256')
    .update(`${deviceId}\0${requestId}\0${resultIndex}\0${problemId}`)
    .digest()
    .subarray(0, 16);
  // RFC 9562 UUIDv8: deterministic application-defined payload plus RFC variant.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
