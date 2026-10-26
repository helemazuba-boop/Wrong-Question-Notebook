import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/rate-limit';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { handleV2Streaming } from '../transcribe-chat/v2-handler';

const Body = z.strictObject({
  text: z.string().trim().min(1).max(4096),
  confirmed: z.literal(true),
});
export async function POST(req: NextRequest) {
  const auth = await authenticateEsp32Device(req);
  if (auth instanceof Response) return auth;
  if (
    !consumeRateLimit('esp32-std-chat', auth.deviceId, {
      windowMs: 60000,
      maxRequests: 12,
    }).ok
  )
    return NextResponse.json(
      {
        success: false,
        error: { code: 'rate_limited', message: '请求过于频繁，请稍后重试。' },
      },
      { status: 429 }
    );
  const raw = await req.text();
  let value: unknown;
  try {
    value = raw.length <= 32768 ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const body = Body.safeParse(value);
  const requestId = req.headers.get('x-wqn-request-id');
  if (
    !body.success ||
    !requestId ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(requestId) ||
    req.headers.get('x-wqn-ai-tier') !== 'std'
  )
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'invalid_input',
          message: '需要明确确认的 STD 输入和请求 ID。',
        },
      },
      { status: 422 }
    );
  return handleV2Streaming(req, undefined, {
    authResult: auth,
    audio: new ArrayBuffer(0),
    confirmedText: body.data.text,
  });
}
