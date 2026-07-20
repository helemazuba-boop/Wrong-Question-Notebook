import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEVICE_CONTROL_SCHEMA_SHA256,
  MAX_SAFE_PROTOCOL_COUNTER,
  bootstrapRequestSchema,
  bootstrapSuccessSchema,
  claimPollSuccessSchema,
  claimStartSuccessSchema,
  syncSuccessSchema,
  v3ErrorEnvelopeSchema,
} from '../device-control-v3';
import {
  deterministicDeviceAttemptId,
  fingerprintDeviceControlRequest,
} from '../device-control-v3-idempotency';

const contractRoot = resolve(process.cwd(), 'contracts/device-control-v3');

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(resolve(contractRoot, path), 'utf8'));
}

describe('device control v3 contract', () => {
  it('pins the authoritative schema hash in code and manifest', () => {
    const schema = readFileSync(
      resolve(contractRoot, 'device-control-v3.schema.json')
    );
    const manifest = fixture('manifest.json') as { schema_sha256: string };
    const digest = createHash('sha256').update(schema).digest('hex');

    expect(digest).toBe(DEVICE_CONTROL_SCHEMA_SHA256);
    expect(manifest.schema_sha256).toBe(digest);
  });

  it.each([
    ['claim-start-response.json', claimStartSuccessSchema],
    ['claim-poll-response.json', claimPollSuccessSchema],
    ['bootstrap-response.json', bootstrapSuccessSchema],
    ['sync-response.json', syncSuccessSchema],
    ['error-response.json', v3ErrorEnvelopeSchema],
  ])('accepts valid fixture %s', (name, schema) => {
    expect(schema.safeParse(fixture(`fixtures/valid/${name}`)).success).toBe(
      true
    );
  });

  it('rejects an error without retry classification', () => {
    expect(
      v3ErrorEnvelopeSchema.safeParse(
        fixture('fixtures/invalid/error-missing-retryable.json')
      ).success
    ).toBe(false);
  });

  it('rejects a success envelope without request correlation', () => {
    expect(
      bootstrapSuccessSchema.safeParse(
        fixture('fixtures/invalid/success-missing-request-id.json')
      ).success
    ).toBe(false);
  });

  it('rejects protocol counters outside JavaScript exact integer range', () => {
    expect(
      bootstrapRequestSchema.safeParse({
        request_id: 'req_bootstrap_0001',
        boot_id: 'boot_bootstrap_001',
        firmware_version: '0.1.0',
        capabilities: [],
        config_revision: MAX_SAFE_PROTOCOL_COUNTER + 1,
        sync_cursor: 0,
      }).success
    ).toBe(false);

    const response = fixture('fixtures/valid/bootstrap-response.json') as {
      data: { config_revision: number };
    };
    response.data.config_revision = MAX_SAFE_PROTOCOL_COUNTER + 1;
    expect(bootstrapSuccessSchema.safeParse(response).success).toBe(false);
  });

  it('fingerprints equivalent JSON independently of object key order', () => {
    expect(
      fingerprintDeviceControlRequest({ b: 2, nested: { y: 1, x: 0 }, a: 1 })
    ).toBe(
      fingerprintDeviceControlRequest({ a: 1, nested: { x: 0, y: 1 }, b: 2 })
    );
  });

  it('derives stable, result-specific UUIDv8 attempt identifiers', () => {
    const first = deterministicDeviceAttemptId(
      'device-1',
      'request-12345678',
      0,
      'problem-1'
    );
    expect(first).toBe(
      deterministicDeviceAttemptId(
        'device-1',
        'request-12345678',
        0,
        'problem-1'
      )
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first).not.toBe(
      deterministicDeviceAttemptId(
        'device-1',
        'request-12345678',
        1,
        'problem-1'
      )
    );
  });
});
