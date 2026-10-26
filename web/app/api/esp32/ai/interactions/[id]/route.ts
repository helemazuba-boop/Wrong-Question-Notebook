import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/rate-limit';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createServiceClient } from '@/lib/supabase-utils';

const Body = z.strictObject({
  answer: z.string().min(1).max(128),
  confirmed: z.literal(true),
});
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof Response) return auth;
  if (
    !consumeRateLimit('esp32-std-reply', auth.deviceId, {
      windowMs: 60000,
      maxRequests: 120,
    }).ok
  )
    return NextResponse.json(
      {
        success: false,
        error: { code: 'rate_limited', message: '请求过于频繁，请稍后重试。' },
      },
      { status: 429 }
    );
  const id = z.uuid().safeParse((await context.params).id);
  const raw = await req.text();
  const body =
    raw.length <= 1024
      ? Body.safeParse(
          (() => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          })()
        )
      : null;
  if (!id.success || !body?.success)
    return NextResponse.json(
      {
        success: false,
        error: { code: 'invalid_answer', message: '确认参数无效。' },
      },
      { status: 422 }
    );
  const { data, error } = await (createServiceClient() as any).rpc(
    'reply_esp32_ai_interaction_v1',
    {
      p_user_id: auth.userId,
      p_device_id: auth.deviceId,
      p_id: id.data,
      p_answer: body.data.answer,
    }
  );
  if (error || !data)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'interaction_unavailable',
          message: '确认已过期或不可用。',
        },
      },
      { status: 409 }
    );
  return NextResponse.json({ success: true, data: { replied: true } });
}
