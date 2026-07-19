import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createSecurityMiddleware,
  type SecurityConfig,
} from './security-middleware';
import { getSecurityHeaders } from './request-validation';

export const DEVICE_CONTROL_PROTOCOL = '3' as const;
export const DEVICE_CONTROL_HEADER = 'X-WQN-Protocol' as const;
export const DEVICE_CONTROL_SCHEMA_SHA256 =
  '95c699ffb77e35f8befff68aff24443bdeabbe381b1eb49910e6dbceedd36cf2' as const;

const requestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const bootIdSchema = requestIdSchema;
const capabilitiesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-z0-9._-]+$/)
  )
  .max(32)
  .refine(values => new Set(values).size === values.length, {
    message: 'Capabilities must be unique',
  });

export const requestMetadataSchema = z.strictObject({
  request_id: requestIdSchema,
  boot_id: bootIdSchema,
  firmware_version: z.string().min(1).max(64),
  capabilities: capabilitiesSchema,
});

export const claimStartRequestSchema = requestMetadataSchema.extend({
  hardware_id: z
    .string()
    .min(12)
    .max(64)
    .regex(/^[A-F0-9:-]+$/),
  device_public_key: z
    .string()
    .min(86)
    .max(88)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/),
});

export const claimPollRequestSchema = requestMetadataSchema.extend({
  claim_id: z.uuid(),
});

export const bootstrapRequestSchema = requestMetadataSchema.extend({
  config_revision: z.number().int().nonnegative(),
  sync_cursor: z.number().int().nonnegative(),
});

export const syncRequestSchema = bootstrapRequestSchema.extend({
  limit: z.number().int().min(1).max(100).optional(),
});

export const v3ErrorSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().min(0).max(86_400_000).optional(),
});

export const v3ErrorEnvelopeSchema = z.strictObject({
  ok: z.literal(false),
  request_id: requestIdSchema,
  error: v3ErrorSchema,
});

export const claimStartDataSchema = z.strictObject({
  claim_id: z.uuid(),
  display_code: z.string().regex(/^[0-9]{8}$/),
  expires_at_ms: z.number().int().nonnegative(),
  poll_interval_ms: z.number().int().min(1000).max(30_000),
});

export const sealedCredentialSchema = z.strictObject({
  server_public_key: z.string().min(86).max(88),
  salt: z.string().min(22).max(44),
  iv: z.string().min(16).max(24),
  ciphertext: z.string().min(32).max(512),
});

export const claimPollDataSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('pending'),
    poll_interval_ms: z.number().int().min(1000).max(30_000),
  }),
  z.strictObject({
    status: z.literal('approved'),
    sealed_credential: sealedCredentialSchema,
  }),
  z.strictObject({ status: z.literal('expired') }),
]);

export const bootstrapDataSchema = z.strictObject({
  device_id: z.uuid(),
  config_revision: z.number().int().nonnegative(),
  sync_cursor: z.number().int().nonnegative(),
  media_protocols: z.strictObject({
    ai_sse: z.literal('v2-streaming'),
    flash: z.literal('wqn-flash-v2'),
  }),
});

export const syncDataSchema = z.strictObject({
  config_revision: z.number().int().nonnegative(),
  sync_cursor: z.number().int().nonnegative(),
  configuration: z.strictObject({
    auto_sync_interval_minutes: z.number().int().min(0).max(1440),
  }),
  summaries: z.strictObject({
    due_problem_ids: z.array(z.uuid()).max(100),
    todo_count: z.number().int().nonnegative(),
    word_due_count: z.number().int().nonnegative(),
  }),
  content_manifest: z
    .array(
      z.strictObject({
        kind: z.enum(['problems', 'todos', 'words', 'word_packs']),
        revision: z.number().int().nonnegative(),
        cursor: z.string().max(256).optional(),
      })
    )
    .max(100),
});

function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    ok: z.literal(true),
    request_id: requestIdSchema,
    server_time_ms: z.number().int().nonnegative(),
    data,
  });
}

export const claimStartSuccessSchema =
  successEnvelopeSchema(claimStartDataSchema);
export const claimPollSuccessSchema =
  successEnvelopeSchema(claimPollDataSchema);
export const bootstrapSuccessSchema =
  successEnvelopeSchema(bootstrapDataSchema);
export const syncSuccessSchema = successEnvelopeSchema(syncDataSchema);

export type ClaimStartRequest = z.infer<typeof claimStartRequestSchema>;
export type ClaimPollRequest = z.infer<typeof claimPollRequestSchema>;
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;
export type SealedCredential = z.infer<typeof sealedCredentialSchema>;
export type SyncData = z.infer<typeof syncDataSchema>;

function generatedRequestId(): string {
  return `srv_${randomUUID().replaceAll('-', '')}`;
}

export function requestIdFromUnknown(value: unknown): string {
  if (typeof value !== 'object' || value === null) return generatedRequestId();
  const candidate = (value as Record<string, unknown>).request_id;
  const parsed = requestIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : generatedRequestId();
}

function v3Headers(): Record<string, string> {
  return {
    [DEVICE_CONTROL_HEADER]: DEVICE_CONTROL_PROTOCOL,
    'Cache-Control': 'no-store',
  };
}

export function createV3SuccessPayload<T>(requestId: string, data: T) {
  return {
    ok: true as const,
    request_id: requestId,
    server_time_ms: Date.now(),
    data,
  };
}

export function createV3JsonResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: v3Headers() });
}

export function createV3Success<T>(requestId: string, data: T) {
  return createV3JsonResponse(createV3SuccessPayload(requestId, data));
}

export function createV3Error(
  requestId: string,
  status: number,
  code: string,
  retryable: boolean,
  retryAfterMs?: number
) {
  const error: z.infer<typeof v3ErrorSchema> = { code, retryable };
  if (retryAfterMs !== undefined) error.retry_after_ms = retryAfterMs;

  return NextResponse.json(
    {
      ok: false as const,
      request_id: requestId,
      error,
    },
    { status, headers: v3Headers() }
  );
}

export function withV3Security<T extends unknown[] = []>(
  handler: (req: NextRequest, ...args: T) => Promise<NextResponse>,
  config: SecurityConfig = {}
) {
  const middleware = createSecurityMiddleware(config);
  return async (req: NextRequest, ...args: T): Promise<NextResponse> => {
    const securityResponse = await middleware(req);
    if (securityResponse) {
      const requestId = requestIdFromUnknown({
        request_id: req.headers.get('X-WQN-Request-Id'),
      });
      if (securityResponse.status === 429) {
        const retryAfterSeconds = Number.parseInt(
          securityResponse.headers.get('Retry-After') ?? '',
          10
        );
        return createV3Error(
          requestId,
          429,
          'RATE_LIMITED',
          true,
          Number.isFinite(retryAfterSeconds)
            ? Math.max(0, retryAfterSeconds * 1000)
            : 60_000
        );
      }
      return createV3Error(requestId, 400, 'REQUEST_REJECTED', false);
    }

    const response = await handler(req, ...args);
    Object.entries(getSecurityHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  };
}

export function rejectWrongV3Protocol(req: Request, requestId: string) {
  if (req.headers.get(DEVICE_CONTROL_HEADER) === DEVICE_CONTROL_PROTOCOL) {
    return null;
  }
  return createV3Error(requestId, 426, 'UPGRADE_REQUIRED', false);
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new TypeError('CONTENT_TYPE');
  }
  return req.json();
}
