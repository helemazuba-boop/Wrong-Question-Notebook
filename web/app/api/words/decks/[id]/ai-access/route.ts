import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
const Body = z.strictObject({ can_read: z.boolean(), can_create: z.boolean() });
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  if (
    req.headers.get('origin') &&
    req.headers.get('origin') !== new URL(req.url).origin
  )
    return NextResponse.json({ error: 'Origin mismatch' }, { status: 403 });
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
