import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-utils';
import { processTodoReminders } from '@/lib/todo-reminders';
import { logger } from '@/lib/logger';
export const maxDuration = 60;
export async function GET(req: Request) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await processTodoReminders(createServiceClient()));
  } catch (error) {
    logger.error('Todo reminder tick failed', error, {
      component: 'TodoReminders',
    });
    return NextResponse.json(
      { error: 'Reminder service unavailable' },
      { status: 503 }
    );
  }
}
