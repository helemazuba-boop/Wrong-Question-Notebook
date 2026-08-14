import { NextRequest, NextResponse } from 'next/server';
import type { Json } from '@/lib/database.types';
import {
  createV3Error,
  createV3JsonResponse,
  createV3SuccessPayload,
  readJsonBody,
  rejectWrongV3Protocol,
  requestIdFromUnknown,
  syncDataSchema,
  syncRequestSchema,
  withV3Security,
} from '@/lib/device-control-v3';
import {
  authenticateDeviceControlV3,
  fingerprintDeviceControlRequest,
  loadDeviceControlReplay,
  storeDeviceControlResponse,
} from '@/lib/device-control-v3-auth';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';

const ENDPOINT = 'sync';

function revisionOf(row: { revision: number } | null): number {
  return row ? Number(row.revision) : 0;
}

async function sync(req: NextRequest) {
  const authRequestId = requestIdFromUnknown({
    request_id: req.headers.get('X-WQN-Request-Id'),
  });
  const protocolError = rejectWrongV3Protocol(req, authRequestId);
  if (protocolError) return protocolError;
  const auth = await authenticateDeviceControlV3(req, authRequestId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return createV3Error(
      // The body is unparseable, but the header still carries the device's
      // request id; echoing it lets the firmware close its queue entry
      // instead of waiting out the timeout on a random id.
      authRequestId,
      400,
      'INVALID_JSON',
      false
    );
  }
  const requestId = requestIdFromUnknown(body);
  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return createV3Error(requestId, 400, 'INVALID_REQUEST', false);
  }
  const fingerprint = fingerprintDeviceControlRequest(parsed.data);
  const replay = await loadDeviceControlReplay({
    deviceId: auth.deviceId,
    requestId,
    endpoint: ENDPOINT,
    fingerprint,
  });
  if (replay.kind !== 'miss') return replay.response;

  const svc = createServiceClient();
  const now = new Date().toISOString();
  const limit = parsed.data.limit ?? 20;
  const autoSyncIntervalMinutes =
    parsed.data.configuration?.auto_sync_interval_minutes ??
    auth.autoSyncIntervalMinutes;
  if (
    parsed.data.configuration &&
    autoSyncIntervalMinutes !== auth.autoSyncIntervalMinutes
  ) {
    const { error: configError } = await svc
      .from('esp32_devices')
      .update({ auto_sync_interval_minutes: autoSyncIntervalMinutes })
      .eq('id', auth.deviceId);
    if (configError) {
      logger.error(
        'Device-control sync configuration update failed',
        configError,
        {
          component: 'DeviceControlV3',
          action: ENDPOINT,
          deviceId: auth.deviceId,
          requestId,
        }
      );
      return createV3Error(
        requestId,
        503,
        'SYNC_CONFIGURATION_UNAVAILABLE',
        true,
        5000
      );
    }
  }
  const [
    dueResult,
    todoCountResult,
    wordDueCountResult,
    problemRevisionResult,
    todoRevisionResult,
    wordRevisionResult,
    packRevisionResult,
    contentRevisionResult,
  ] = await Promise.all([
    svc
      .from('review_schedule')
      .select('problem_id')
      .eq('user_id', auth.userId)
      .lte('next_review_at', now)
      .order('next_review_at', { ascending: true })
      .limit(limit),
    svc
      .from('todos')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', auth.userId)
      .eq('status', 'pending'),
    svc
      .from('word_progress')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', auth.userId)
      .or(`status.eq.new,due_at.is.null,due_at.lte.${now}`),
    svc
      .from('problems')
      .select('revision')
      .eq('user_id', auth.userId)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('todos')
      .select('revision')
      .eq('user_id', auth.userId)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('word_decks')
      .select('revision')
      .or(`user_id.eq.${auth.userId},is_system.eq.true`)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('word_packs')
      .select('revision')
      .eq('status', 'ready')
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
    (svc as any).rpc('get_device_content_revisions', {
      p_user_id: auth.userId,
    }),
  ]);

  const queryError = [
    dueResult.error,
    todoCountResult.error,
    wordDueCountResult.error,
    problemRevisionResult.error,
    todoRevisionResult.error,
    wordRevisionResult.error,
    packRevisionResult.error,
    contentRevisionResult.error,
  ].find(Boolean);
  if (queryError) {
    logger.error('Device-control sync query failed', queryError, {
      component: 'DeviceControlV3',
      action: ENDPOINT,
      deviceId: auth.deviceId,
      requestId,
    });
    return createV3Error(requestId, 503, 'SYNC_UNAVAILABLE', true, 5000);
  }

  const problemRevision = revisionOf(problemRevisionResult.data);
  const todoRevision = revisionOf(todoRevisionResult.data);
  const wordRevision = revisionOf(wordRevisionResult.data);
  const packRevision = revisionOf(packRevisionResult.data);
  const contentRevisions = new Map<string, number>(
    (
      (contentRevisionResult.data || []) as Array<{
        domain: string;
        revision: number | string;
      }>
    ).map(row => [row.domain, Number(row.revision)])
  );
  const contentRevision = (domain: string) => contentRevisions.get(domain) ?? 0;
  const todoContentRevision = contentRevision('todos');
  const wordPackContentRevision = contentRevision('word_packs');
  const notePackContentRevision = contentRevision('note_packs');
  const problemPackContentRevision = contentRevision('problem_packs');
  const acknowledgedSyncCursor = Math.max(
    auth.syncCursor,
    parsed.data.sync_cursor
  );
  const syncCursor = Math.max(
    acknowledgedSyncCursor,
    problemRevision,
    todoRevision,
    wordRevision,
    packRevision,
    todoContentRevision,
    wordPackContentRevision,
    notePackContentRevision,
    problemPackContentRevision
  );
  const data = syncDataSchema.parse({
    config_revision: auth.configRevision,
    sync_cursor: syncCursor,
    // Echo the device-reported local setting. Older devices omit it and use
    // the last server-side value seeded by the migration.
    configuration: {
      auto_sync_interval_minutes: autoSyncIntervalMinutes,
    },
    summaries: {
      due_problem_ids: (dueResult.data || []).map(row => row.problem_id),
      todo_count: todoCountResult.count ?? 0,
      word_due_count: wordDueCountResult.count ?? 0,
    },
    content_manifest: [
      {
        kind: 'problems',
        revision: problemRevision,
        cursor: `problems:${problemRevision}`,
      },
      {
        kind: 'todos',
        revision: todoContentRevision,
        cursor: `todos:${todoContentRevision}`,
      },
      {
        kind: 'words',
        revision: wordRevision,
        cursor: `words:${wordRevision}`,
      },
      {
        kind: 'word_packs',
        revision: wordPackContentRevision,
        cursor: `word_packs:${wordPackContentRevision}`,
      },
      {
        kind: 'note_packs',
        revision: notePackContentRevision,
        cursor: `note_packs:${notePackContentRevision}`,
      },
      {
        kind: 'problem_packs',
        revision: problemPackContentRevision,
        cursor: `problem_packs:${problemPackContentRevision}`,
      },
    ],
  });
  const payload = createV3SuccessPayload(requestId, data);

  const stored = await storeDeviceControlResponse({
    deviceId: auth.deviceId,
    requestId,
    endpoint: ENDPOINT,
    fingerprint,
    status: 200,
    responseBody: payload as unknown as Json,
    firmwareVersion: parsed.data.firmware_version,
    capabilities: parsed.data.capabilities,
    bootId: parsed.data.boot_id,
    seenAt: now,
    lastSyncAt: now,
    acknowledgedSyncCursor,
  });
  if (stored.kind !== 'stored') return stored.response;
  return createV3JsonResponse(payload);
}

export const POST = withV3Security(sync, {
  rateLimitType: 'api',
  rateLimitKey: 'ip',
  enableRequestValidation: false,
});
