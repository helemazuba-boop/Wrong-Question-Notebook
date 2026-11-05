import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import {
  outboxReceiptDataSchema,
  outboxReceiptRequestSchema,
} from '../outbox-reconciliation-v1';
import { readOutboxReceipts } from '../outbox-reconciliation-service';

const root = resolve(process.cwd(), 'contracts/outbox-reconciliation-v1');
const schemaText = readFileSync(
  resolve(root, 'outbox-reconciliation-v1.schema.json'),
  'utf8'
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(schemaText));
function fixture(name: string) {
  return JSON.parse(
    readFileSync(resolve(root, 'fixtures/valid', name), 'utf8')
  );
}

describe('outbox reconciliation wire contract', () => {
  it('pins the independently mirrored schema bytes', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'manifest.json'), 'utf8')
    );
    expect(createHash('sha256').update(schemaText).digest('hex')).toBe(
      manifest.schema_sha256
    );
    expect(manifest.max_request_ids).toBe(64);
    expect(manifest.repair_authorized).toBe(false);
  });

  it.each([
    'word-request.json',
    'note-request.json',
    'word-response.json',
    'note-response.json',
    'unavailable-response.json',
  ])('accepts the golden fixture %s', name => {
    const payload = fixture(name);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    if (name.endsWith('request.json'))
      expect(outboxReceiptRequestSchema.safeParse(payload).success).toBe(true);
    if (payload.ok === true)
      expect(outboxReceiptDataSchema.safeParse(payload.data).success).toBe(
        true
      );
  });

  it.each(['word', 'note'])(
    'validates actual SQL-origin %s receipts at the service boundary',
    async domain => {
      const request = fixture(domain + '-request.json');
      const data = fixture(domain + '-response.json').data;
      const rpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({ data, error: null }),
      });
      await expect(
        readOutboxReceipts(
          { rpc } as never,
          data.actor.user_id,
          data.actor.device_id,
          request
        )
      ).resolves.toEqual(data);
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        'lookup_device_outbox_receipts_v1',
        {
          p_user_id: data.actor.user_id,
          p_device_id: data.actor.device_id,
          p_domain: domain,
          p_session_id: request.session_id,
          p_request_ids: request.request_ids,
        }
      );
    }
  );

  it.each([
    'duplicates',
    'limit',
    'actor-injection',
    'contract',
    'empty',
    'capability',
  ])('both validators reject invalid request %s', field => {
    const request = fixture('word-request.json');
    if (field === 'duplicates')
      request.request_ids.push(request.request_ids[0]);
    if (field === 'limit')
      request.request_ids = Array.from(
        { length: 65 },
        (_, i) => `receipt_limit_${String(i).padStart(5, '0')}`
      );
    if (field === 'actor-injection')
      request.user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (field === 'contract') request.contract = 'future-contract';
    if (field === 'empty') request.request_ids = [];
    if (field === 'capability') request.capabilities = ['BAD CAPABILITY'];
    expect(validate(request)).toBe(false);
    expect(outboxReceiptRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    'repair',
    'counter',
    'unknown-field',
    'state',
    'payload',
    'timestamp',
    'session-mode',
  ])('both validators reject invalid reply %s', field => {
    const reply = fixture('word-response.json');
    if (field === 'repair') reply.data.repair_authorized = true;
    if (field === 'counter')
      reply.data.session.next_sequence = Number.MAX_SAFE_INTEGER + 1;
    if (field === 'unknown-field') reply.data.receipts[0].acknowledge = true;
    if (field === 'state') reply.data.receipts[0].state = 'safe-to-replay';
    if (field === 'payload') reply.data.receipts[0].state = 'conflict';
    if (field === 'timestamp') reply.data.read_at = 'not-a-date';
    if (field === 'session-mode') reply.data.session.mode = 'recent';
    expect(validate(reply)).toBe(false);
    expect(outboxReceiptDataSchema.safeParse(reply.data).success).toBe(false);
  });
});
