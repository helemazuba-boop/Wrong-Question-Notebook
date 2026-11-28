import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/esp32/v3/study/recovery/context/route';
import { _resetRateLimitStore } from '@/lib/rate-limit';
import { hashDeviceToken } from '../esp32-token';
import {
  OUTBOX_RECOVERY_CONTEXT_MAX_RESPONSE_BYTES,
  OUTBOX_RECOVERY_CONTEXT_TIMEOUT_MS,
  outboxRecoveryContextDataSchema,
  outboxRecoveryContextRequestSchema,
  type OutboxRecoveryContextData,
  type OutboxRecoveryContextRequest,
} from '../outbox-recovery-context-v1';
import pages from '../../contracts/outbox-recovery-context-v1/pages.json';

const { authenticate, rpc, abort } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  rpc: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('@/lib/device-control-v3-auth', () => ({
  authenticateDeviceControlV3: authenticate,
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc }),
}));

const token = 'a'.repeat(64);
const first = outboxRecoveryContextDataSchema.parse(pages[0]);
const requestId = 'context_query_00000001';

function query(page: OutboxRecoveryContextData): OutboxRecoveryContextRequest {
  const base = {
    request_id: requestId,
    boot_id: 'context_boot_00000001',
    firmware_version: '0.1.0-test',
    capabilities: ['outbox.recovery.context.v1'],
    contract: page.contract,
    domain: page.domain,
    session_id: page.session_id,
    nonce: page.binding.nonce,
    manifest_sha256: page.binding.manifest_sha256,
    elf_sha256: page.binding.elf_sha256,
  };
  if (page.part === 'session')
    return {
      ...base,
      part: 'session',
      offset: 0,
      expected_context_sha256: null,
    };
  if (page.part === 'receipts')
    return {
      ...base,
      part: 'receipts',
      offset: 0,
      expected_context_sha256: page.context_sha256,
      request_ids: page.receipts.map(row => row.request_id),
    };
  return {
    ...base,
    part: page.part,
    offset: page.offset,
    expected_context_sha256: page.context_sha256,
  };
}

function request(
  body: unknown = query(first),
  mac: string | null = first.binding.source_mac
) {
  return new NextRequest(
    'http://localhost/api/esp32/v3/study/recovery/context',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-wqn-protocol': '3',
        'x-wqn-request-id': requestId,
        'x-forwarded-for': '127.0.0.1',
        ...(mac === null ? {} : { 'x-wqn-source-mac': mac }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  _resetRateLimitStore();
  authenticate.mockResolvedValue({
    userId: first.actor.user_id,
    deviceId: first.actor.device_id,
  });
  rpc.mockReturnValue({ abortSignal: abort });
  abort.mockResolvedValue({ data: first, error: null });
});

describe('read-only recovery context route', () => {
  const liveLog = process.env.R08_SQL_WIRE_LOG;
  const sqlPages: unknown[] = liveLog
    ? readFileSync(liveLog, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('WIRE '))
        .map(line => JSON.parse(line.slice(5)))
    : pages;

  it('passes every database-origin page through the real route and keeps complete histories', async () => {
    const candidates: number[] = [];
    const pins: number[] = [];
    const wordContext = outboxRecoveryContextDataSchema.parse(
      sqlPages[0]
    ).context_sha256;
    expect(sqlPages).toHaveLength(25);
    for (const raw of sqlPages) {
      const page = outboxRecoveryContextDataSchema.parse(raw);
      const input = query(page);
      expect(outboxRecoveryContextRequestSchema.safeParse(input).success).toBe(
        true
      );
      abort.mockResolvedValueOnce({ data: raw, error: null });
      _resetRateLimitStore();
      const response = await POST(request(input));
      expect(
        response.status,
        `${page.domain} ${page.part} ${page.offset}`
      ).toBe(200);
      expect(response.headers.get('x-wqn-context-source-mac')).toBe(
        page.binding.source_mac
      );
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = await response.text();
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
        OUTBOX_RECOVERY_CONTEXT_MAX_RESPONSE_BYTES
      );
      expect(JSON.parse(body)).toMatchObject({
        ok: true,
        request_id: requestId,
        data: page,
      });
      if (page.domain === 'word') {
        expect(page.context_sha256).toBe(wordContext);
        if (page.part === 'pins') pins.push(...page.pins.map(row => row.index));
        if (page.part === 'candidates')
          candidates.push(...page.candidates.map(row => row.index));
      }
    }
    expect(candidates).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(pins).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(rpc).toHaveBeenCalledTimes(25);
  });

  it('uses the bound RPC, current credential hash, and bounded abort signal', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const response = await POST(
      request(query(first), first.binding.source_mac.toUpperCase())
    );
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      'read_device_outbox_recovery_context_v1',
      {
        p_user_id: first.actor.user_id,
        p_device_id: first.actor.device_id,
        p_domain: first.domain,
        p_session_id: first.session_id,
        p_source_mac: first.binding.source_mac,
        p_token_sha256: hashDeviceToken(token),
        p_nonce: first.binding.nonce,
        p_manifest_sha256: first.binding.manifest_sha256,
        p_elf_sha256: first.binding.elf_sha256,
        p_part: 'session',
        p_offset: 0,
        p_expected_context_sha256: null,
        p_request_ids: [],
      }
    );
    expect(spy).toHaveBeenCalledWith(OUTBOX_RECOVERY_CONTEXT_TIMEOUT_MS);
    expect(abort).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it.each([null, '', 'invalid'])(
    'requires a normalized source MAC (%s)',
    async mac => {
      const response = await POST(request(query(first), mac));
      expect(response.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it('passes disabled-account response through without querying history', async () => {
    authenticate.mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [null, null, 404],
    [null, { code: '40001', message: 'OUTBOX_RECOVERY_CONTEXT_CHANGED' }, 409],
    [
      null,
      { code: '22023', message: 'INVALID_OUTBOX_RECOVERY_CONTEXT_OFFSET' },
      400,
    ],
    [null, { code: '40001', message: 'temporary' }, 503],
    [null, { code: 'XX000', message: 'internal' }, 503],
  ])(
    'maps unavailable or changed context without substituting another RPC',
    async (data, error, status) => {
      abort.mockResolvedValueOnce({ data, error });
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(response.headers.has('x-wqn-context-source-mac')).toBe(false);
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['nonce', 'manifest_sha256', 'elf_sha256', 'source_mac'] as const)(
    'rejects a mismatched %s on the response',
    async field => {
      abort.mockResolvedValueOnce({
        data: {
          ...first,
          binding: {
            ...first.binding,
            [field]: 'd'.repeat(first.binding[field].length),
          },
        },
        error: null,
      });
      expect((await POST(request())).status).toBe(503);
    }
  );

  it('rejects foreign actor, altered candidate indices and inconsistent pages', async () => {
    const page = outboxRecoveryContextDataSchema.parse(
      pages.find(p => p.part === 'candidates')
    );
    if (page.part !== 'candidates')
      throw new Error('candidate fixture missing');
    for (const altered of [
      { ...page, actor: { ...page.actor, user_id: page.session_id } },
      { ...page, context_sha256: 'a'.repeat(64) },
      { ...page, candidates: page.candidates.slice(1) },
      { ...page, next_offset: page.next_offset + 1 },
      { ...page, has_more: false },
      { ...page, repair_authorized: true },
      {
        ...page,
        candidates: [
          { ...page.candidates[0], index: 1 },
          ...page.candidates.slice(1),
        ],
      },
    ]) {
      _resetRateLimitStore();
      abort.mockResolvedValueOnce({ data: altered, error: null });
      expect((await POST(request(query(page)))).status).toBe(503);
    }
  });

  it('keeps receipt request identity and disposition order', async () => {
    const page = outboxRecoveryContextDataSchema.parse(
      pages.find(p => p.part === 'receipts')
    );
    if (page.part !== 'receipts') throw new Error('receipt fixture missing');
    abort.mockResolvedValueOnce({
      data: { ...page, receipts: [...page.receipts].reverse() },
      error: null,
    });
    expect((await POST(request(query(page)))).status).toBe(503);
    abort.mockResolvedValueOnce({ data: page, error: null });
    const response = await POST(request(query(page)));
    expect(response.status).toBe(200);
    expect(
      (await response.json()).data.receipts.map(
        (row: { state: string }) => row.state
      )
    ).toEqual(['found', 'not_found', 'conflict']);
  });

  it('enforces request budget and rejects actor injection or unpinned follow-up', async () => {
    expect((await POST(request(' '.repeat(4097)))).status).toBe(413);
    expect(
      (await POST(request({ ...query(first), user_id: first.actor.user_id })))
        .status
    ).toBe(400);
    expect(
      (await POST(request({ ...query(first), part: 'pins' }))).status
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps the pinned JSON schemas aligned and accepts actual SQL pages in AJV', () => {
    const root = 'contracts/outbox-recovery-context-v1/';
    const requestSchema = JSON.parse(
      readFileSync(root + 'request.schema.json', 'utf8')
    );
    const dataSchema = JSON.parse(
      readFileSync(root + 'data.schema.json', 'utf8')
    );
    expect(requestSchema).toEqual(
      z.toJSONSchema(outboxRecoveryContextRequestSchema)
    );
    expect(dataSchema).toEqual(z.toJSONSchema(outboxRecoveryContextDataSchema));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const checkRequest = ajv.compile(requestSchema);
    const checkData = ajv.compile(dataSchema);
    for (const raw of sqlPages) {
      const page = outboxRecoveryContextDataSchema.parse(raw);
      expect(
        checkRequest(query(page)),
        JSON.stringify(checkRequest.errors)
      ).toBe(true);
      expect(checkData(page), JSON.stringify(checkData.errors)).toBe(true);
    }
    expect(checkData({ ...first, repair_authorized: true })).toBe(false);
  });

  it('pins the original database fixture bytes', () => {
    const body = readFileSync(
      'contracts/outbox-recovery-context-v1/pages.json'
    );
    const checksum = readFileSync(
      'contracts/outbox-recovery-context-v1/pages.sha256',
      'utf8'
    ).trim();
    expect(createHash('sha256').update(body).digest('hex')).toBe(checksum);
  });
});
