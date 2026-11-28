import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { openCodeControl } from '@/lib/opencode-agent-control';

export const runtime = 'nodejs';
const Body = z
  .object({
    action: z.enum([
      'lookup',
      'reserve',
      'settle',
      'fallback',
      'activity',
      'finish',
      'failure',
      'bind',
    ]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.WQN_OPENCODE_CONTROL_SECRET;
  const supplied =
    req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (
    !secret ||
    secret.length < 32 ||
    Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))
  )
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const reader = req.body?.getReader();
    if (!reader)
      return Response.json({ error: 'invalid_request' }, { status: 422 });
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel();
        return Response.json({ error: 'invalid_size' }, { status: 413 });
      }
      parts.push(value);
    }
    const { action, payload } = Body.parse(
      JSON.parse(Buffer.concat(parts).toString('utf8'))
    );
    const data = await openCodeControl(action, payload);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json({ error: 'invalid_request' }, { status: 422 });
    // Never reflect database/provider payloads or credentials.
    return Response.json({ error: 'control_denied' }, { status: 409 });
  }
}
