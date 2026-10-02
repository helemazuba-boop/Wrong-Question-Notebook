import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isCurrentUserSuperAdmin } from '@/lib/user-management';
import { createServiceClient } from '@/lib/supabase-utils';

export const dynamic = 'force-dynamic';

// `action: 'all'` is intentionally explicit rather than a default: requeueing
// the whole backlog re-runs every unfinished annotation, which costs provider
// calls. It is the escape hatch for a Registry lock bump, not a routine action.
const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('all') }),
  z.object({ action: z.literal('problem'), problem_id: z.uuid() }),
]);

async function requireSuperAdmin() {
  return isCurrentUserSuperAdmin();
}

export async function GET() {
  try {
    if (!(await requireSuperAdmin())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc(
      'problem_mark_annotation_health'
    );
    if (error) {
      return NextResponse.json(
        { error: 'Failed to read annotation queue health' },
        { status: 500 }
      );
    }

    return NextResponse.json({ health: data });
  } catch (error) {
    console.error('Error reading Problem Mark queue health:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    if (!(await requireSuperAdmin())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    if (parsed.data.action === 'all') {
      const { data, error } = await supabase.rpc(
        'requeue_all_problem_mark_annotations'
      );
      if (error) {
        return NextResponse.json(
          { error: 'Failed to requeue annotations' },
          { status: 500 }
        );
      }
      return NextResponse.json({ requeued: data });
    }

    const { data, error } = await supabase.rpc(
      'requeue_problem_mark_annotation',
      { p_problem_id: parsed.data.problem_id }
    );
    if (error) {
      return NextResponse.json(
        { error: 'Failed to requeue annotation', details: error.message },
        { status: 409 }
      );
    }
    return NextResponse.json({ requeued: data });
  } catch (error) {
    console.error('Error requeueing Problem Mark annotations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
