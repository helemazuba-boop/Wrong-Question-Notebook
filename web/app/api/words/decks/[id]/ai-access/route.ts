import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { isTrustedWriteOrigin } from '@/lib/cookie-write-origin';
const Body = z.strictObject({ can_read: z.boolean(), can_create: z.boolean() });
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  if (!isTrustedWriteOrigin(req))
    return NextResponse.json(
      {
        error: {
          code: 'origin_mismatch',
          message: '请求来源与站点地址不一致，请从 WQN 页面重试。',
        },
      },
      { status: 403 }
    );
  const id = z.uuid().safeParse((await params).id),
    body = Body.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success)
    return NextResponse.json({ error: 'Invalid permission' }, { status: 400 });
  const { data, error } = await (supabase as any).rpc(
    'set_word_deck_ai_access_v2',
    {
      p_deck_id: id.data,
      p_can_read: body.data.can_read,
      p_can_create: body.data.can_create,
    }
  );
  if (error)
    return NextResponse.json({ error: 'Deck not owned' }, { status: 403 });
  return NextResponse.json({ data });
}
