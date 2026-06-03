import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';
import { createApiErrorResponse, createApiSuccessResponse } from '@/lib/common-utils';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  completeTodoFromDevice,
  TodoToolError,
} from '@/lib/todos';

const CompleteTodoSchema = z.object({
  todo_id: z.string().uuid(),
});

export async function POST(req: Request) {
  const authResult = await authenticateEsp32Device(req);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const parsed = CompleteTodoSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        createApiErrorResponse('Invalid Todo complete request', 400, {
          code: 'invalid_request',
        }),
        { status: 400 }
      );
    }

    const result = await completeTodoFromDevice(
      {
        userId: authResult.userId,
        deviceId: authResult.deviceId,
        supabase: createServiceClient(),
      },
      parsed.data
    );

    return NextResponse.json(
      createApiSuccessResponse({
        todo: result.todo,
        action: result.action,
      })
    );
  } catch (error) {
    if (error instanceof TodoToolError) {
      return NextResponse.json(
        createApiErrorResponse(error.message, error.status, { code: error.code }),
        { status: error.status }
      );
    }

    return NextResponse.json(
      createApiErrorResponse('Failed to complete Todo', 500, {
        code: 'todo_failed',
      }),
      { status: 500 }
    );
  }
}
