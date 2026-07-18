import { NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  handleAsyncError,
} from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

async function syncDueProblems(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  const { userId, deviceId } = authResult;

  try {
    const body = await req.json();
    const { firmware_version, limit } = body as {
      firmware_version?: string;
      limit?: number;
    };

    const queryLimit = Math.min(Math.max(limit || 20, 1), 100);

    const svc = createServiceClient();
    const now = new Date().toISOString();

    // Get due problems (next_review_at <= now)
    const { data: dueProblems, error: dueProblemsError } = await svc
      .from('review_schedule')
      .select('problem_id, next_review_at')
      .eq('user_id', userId)
      .lte('next_review_at', now)
      .order('next_review_at', { ascending: true })
      .limit(queryLimit);

    if (dueProblemsError) {
      return NextResponse.json(
        createApiErrorResponse('Failed to load due problems', 500),
        { status: 500 }
      );
    }

    if (!dueProblems || dueProblems.length === 0) {
      // Update device last_seen even if no problems
      await svc
        .from('esp32_devices')
        .update({ last_seen_at: now, firmware_version })
        .eq('id', deviceId);

      return NextResponse.json(
        createApiSuccessResponse({ due_problems: [], total: 0 })
      );
    }

    const problemIds = dueProblems.map(p => p.problem_id);

    // Update device info and last_sync_at
    await svc
      .from('esp32_devices')
      .update({
        last_seen_at: now,
        last_sync_at: now,
        firmware_version: firmware_version || undefined,
      })
      .eq('id', deviceId);

    return NextResponse.json(
      createApiSuccessResponse({
        due_problems: problemIds,
        total: problemIds.length,
      })
    );
  } catch (error) {
    const { message, status } = handleAsyncError(error);
    return NextResponse.json(createApiErrorResponse(message, status), {
      status,
    });
  }
}

export const POST = withSecurity(syncDueProblems, {
  enableRateLimit: false,
  enableRequestValidation: false,
});
