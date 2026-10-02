import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isValidRedirectUri } from './service';

// Client ID Metadata Documents (CIMD).
//
// The MCP authorization spec prefers CIMD over Dynamic Client Registration:
// instead of every client registering with every server up front, the client
// publishes a JSON document at an HTTPS URL and uses that URL as its
// client_id. The server fetches the document on demand.
//
// That fetch is the dangerous part -- the URL is supplied by an untrusted
// client, so this module treats it as an SSRF sink: HTTPS only, no redirects,
// capped size, and every resolved address checked against the private,
// loopback, link-local and reserved ranges before a connection is made.

const FETCH_TIMEOUT_MS = 8000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 20;
const MAX_CLIENT_NAME_LENGTH = 100;

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return IPV4_BLOCKED_RANGES.some(([base, prefixBits]) => {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) return true;
    const mask = (0xffffffff << (32 - prefixBits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

function expandIpv6Groups(address: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] =>
    segment === ''
      ? []
      : segment.split(':').map(group => {
          if (!/^[0-9a-f]{1,4}$/.test(group)) return Number.NaN;
          return Number.parseInt(group, 16);
        });

  const head = parseGroups(halves[0]);
  if (head.some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseGroups(halves[1]);
  if (tail.some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIpv6(ip: string): boolean {
  let address = ip.toLowerCase();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);

  // IPv4-mapped (::ffff:127.0.0.1) must be judged as the embedded IPv4
  // address, otherwise a loopback target slips through the IPv6 rules.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isBlockedIpv4(mapped[1]);

  const groups = expandIpv6Groups(address);
  if (!groups) return true;

  // IPv4-mapped (::ffff:a.b.c.d). The URL and DNS layers normalise the dotted
  // form to hex, so both shapes have to be recognised or a loopback target
  // written as ::ffff:127.0.0.1 would slip through the IPv6 rules below.
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }

  if (groups.every(group => group === 0)) return true; // ::
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32

  // Deprecated IPv4-compatible ::a.b.c.d -- still routes as IPv4.
  if (
    groups.slice(0, 6).every(g => g === 0) &&
    (groups[6] !== 0 || groups[7] !== 0)
  ) {
    return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }

  return false;
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedIpv4(ip);
  if (isIP(ip) === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * Reject hosts that resolve into internal address space.
 *
 * Note the inherent TOCTOU gap: name resolution here and the resolution done
 * by the subsequent fetch are two separate lookups, so a rebinding attacker
 * could win the race between them. Closing it properly means pinning the
 * connection to the validated IP with the hostname in SNI, which Node's
 * fetch cannot express. The remaining exposure is limited because the fetch
 * is a plain GET to a public JSON document with no credentials attached.
 */
async function isPubliclyRoutableHost(hostname: string): Promise<boolean> {
  // WHATWG URL keeps the brackets around an IPv6 literal, and isIP() does not
  // accept them -- without stripping, every IPv6 address would fall through to
  // a DNS lookup that a hostile resolver could answer however it likes.
  const host = hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) return !isBlockedIp(host);

  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    return false;
  }
  if (records.length === 0) return false;
  return records.every(record => !isBlockedIp(record.address));
}

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

/**
 * Why a document could not be retrieved.
 *
 * A collapsed "fetch failed" tells an operator nothing: a blocked egress
 * firewall, a broken resolver and a slow host need completely different
 * responses. The code is logged so the failure is actionable without
 * reproducing it.
 */
export type CimdFailureReason =
  'timeout' | 'dns' | 'unreachable' | 'tls' | 'http_status' | 'unknown';

export class CimdError extends Error {
  readonly reason: CimdFailureReason;

  constructor(message: string, reason: CimdFailureReason = 'unknown') {
    super(message);
    this.name = 'CimdError';
    this.reason = reason;
  }
}

/**
 * Walk the `cause` chain for the first recognisable error code.
 *
 * Node's fetch (undici) flattens every network failure into a bare
 * `TypeError: fetch failed`; the real reason -- ENOTFOUND, ECONNREFUSED,
 * ETIMEDOUT, a TLS code -- lives on `error.cause`, sometimes several links
 * down. Reading only the top level would collapse every one of these into
 * "unknown", which is exactly the undebuggable state this classification
 * exists to prevent.
 */
function rootCauseCode(error: unknown): string {
  let current = error as NodeJS.ErrnoException | null | undefined;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === 'string' && current.code) return current.code;
    current = current.cause as NodeJS.ErrnoException | null | undefined;
  }
  return '';
}

const DNS_FAILURE_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'];
const UNREACHABLE_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
];
const TIMEOUT_CODES = ['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR'];

function describeFetchFailure(error: unknown): CimdError {
  if (error instanceof Error && error.name === 'AbortError') {
    return new CimdError(
      `Client metadata fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
      'timeout'
    );
  }

  const code = rootCauseCode(error);

  if (TIMEOUT_CODES.includes(code) || code === 'ABORT_ERR') {
    return new CimdError(
      `Client metadata fetch timed out (${code || 'no code'})`,
      'timeout'
    );
  }
  if (DNS_FAILURE_CODES.includes(code)) {
    return new CimdError(
      `Client metadata host could not be resolved (${code})`,
      'dns'
    );
  }
  if (UNREACHABLE_CODES.includes(code)) {
    return new CimdError(
      `Client metadata host is unreachable (${code})`,
      'unreachable'
    );
  }
  if (code.startsWith('CERT') || code.includes('SSL') || code.includes('TLS')) {
    return new CimdError(
      `Client metadata TLS handshake failed (${code})`,
      'tls'
    );
  }
  if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return new CimdError(
      `Client metadata TLS verification failed (${code})`,
      'tls'
    );
  }

  return new CimdError(
    `Failed to fetch client metadata document (${code || 'no error code'})`,
    code ? 'unknown' : 'unknown'
  );
}

const ClientMetadataDocumentSchema = z.object({
  client_id: z.string().min(1).max(2048),
  client_name: z.string().min(1).max(MAX_CLIENT_NAME_LENGTH).optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
});

/** True when a client_id is a URL, meaning it must be resolved via CIMD. */
export function isCimdClientId(clientId: string): boolean {
  return /^https:\/\//i.test(clientId);
}

async function readCappedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        throw new CimdError('Client metadata document exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    if (total > MAX_DOCUMENT_BYTES) await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch and validate a Client ID Metadata Document.
 *
 * Throws CimdError on any failure; callers surface it as invalid_client.
 */
export async function fetchClientMetadataDocument(
  clientId: string
): Promise<ClientMetadata> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdError('client_id is not a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw new CimdError('Client metadata document must be served over HTTPS');
  }
  if (url.username || url.password) {
    throw new CimdError('Client metadata URL must not contain credentials');
  }
  if (!(await isPubliclyRoutableHost(url.hostname))) {
    throw new CimdError('Client metadata URL resolves to a private address');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    // Redirects are refused rather than followed: a 302 to an internal host
    // would bypass the address check above.
    response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof CimdError) throw error;
    throw describeFetchFailure(error);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 200) {
    throw new CimdError(
      `Client metadata document returned HTTP ${response.status}`,
      'http_status'
    );
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new CimdError('Client metadata document is not JSON');
  }

  const raw = await readCappedBody(response);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new CimdError('Client metadata document is not valid JSON');
  }

  const parsed = ClientMetadataDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new CimdError('Client metadata document is malformed');
  }

  // The document must identify itself by the exact URL it was fetched from,
  // otherwise one host could publish metadata claiming another's identity.
  if (parsed.data.client_id !== clientId) {
    throw new CimdError(
      'Client metadata document client_id does not match the requested URL'
    );
  }

  const redirectUris = parsed.data.redirect_uris;
  if (!redirectUris.every(isValidRedirectUri)) {
    throw new CimdError(
      'Client metadata document contains an unsupported redirect_uri'
    );
  }

  return {
    clientId,
    clientName: parsed.data.client_name ?? url.hostname,
    redirectUris,
  };
}
