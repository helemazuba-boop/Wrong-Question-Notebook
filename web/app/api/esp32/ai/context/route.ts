import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyInternalRequest } from '@/lib/internal-request-auth';
import { createServiceClient } from '@/lib/supabase-utils';
import { loadVoiceContext } from '@/lib/ai-tools/voice-context-server';
export const runtime = 'nodejs';
const Body = z.strictObject({
  // Persisted seed accounts use canonical PostgreSQL UUIDs without RFC bits.
  user_id: z.guid(),
  device_id: z.uuid(),
  anchor_at: z.iso.datetime({ offset: true }).optional(),
});
export async function POST(req: NextRequest) {
  const secret = process.env.WQN_REALTIME_PROXY_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    req.headers.get('authorization') !== `Bearer ${secret}` ||
    (process.env.WQN_INTERNAL_API_ALLOWED_HOST &&
      req.headers.get('host') !== process.env.WQN_INTERNAL_API_ALLOWED_HOST)
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (Number(req.headers.get('content-length') ?? 0) > 4096)
    return NextResponse.json({ error: 'Context too large' }, { status: 413 });
  const raw = await req.text();
  if (raw.length > 4096)
    return NextResponse.json({ error: 'Context too large' }, { status: 413 });
  if (
    !verifyInternalRequest({
      secret,
      timestamp: req.headers.get('x-wqn-internal-timestamp'),
      signature: req.headers.get('x-wqn-internal-signature'),
      body: raw,
    })
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  const body = Body.safeParse(input);
  if (!body.success)
    return NextResponse.json({ error: 'Invalid context' }, { status: 400 });
  const db = createServiceClient();
  const { data, error } = await db
    .from('esp32_devices')
    .select('id')
    .eq('id', body.data.device_id)
    .eq('user_id', body.data.user_id)
    .maybeSingle();
  if (error || !data)
    return NextResponse.json(
      { error: 'Device context mismatch' },
      { status: 401 }
    );
  try {
    return NextResponse.json(
      {
        data: await loadVoiceContext(
          { userId: body.data.user_id, supabase: db },
          body.data.anchor_at
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Voice context unavailable' },
      { status: (error as Error).message === 'Account disabled' ? 403 : 503 }
    );
  }
}
