import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import {
  Esp32AiProviderError,
  runEsp32WordAiLookup,
} from '@/lib/esp32-ai-provider';

export const runtime = 'nodejs';

const LookupSchema = z.object({
  word: z.string().trim().min(1).max(80),
  context: z.string().trim().max(500).optional().nullable(),
});

type LookupErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'disabled'
  | 'rate_limited'
  | 'model_failed';

function errorResponse(
  code: LookupErrorCode,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code, message },
    },
    { status }
  );
}

export async function POST(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const parsed = LookupSchema.safeParse(await req.json());
    if (!parsed.success) {
      return errorResponse(
        'invalid_request',
        'Invalid word AI lookup request',
        400
      );
    }

    const lookup = await runEsp32WordAiLookup(parsed.data);
    return NextResponse.json({
      success: true,
      data: {
        lookup,
      },
    });
  } catch (error) {
    if (error instanceof Esp32AiProviderError) {
      const code: LookupErrorCode =
        error.code === 'disabled' || error.code === 'rate_limited'
          ? error.code
          : 'model_failed';
      return errorResponse(code, error.message, error.status);
    }

    return errorResponse('model_failed', 'Word AI lookup failed', 500);
  }
}
