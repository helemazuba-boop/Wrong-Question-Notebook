import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { AssetReference } from '@/lib/mcp/v2-contracts';
import { deriveProblemImageAssets } from '@/lib/problem-image-service';
import { revalidateProblemComprehensive } from '@/lib/cache-invalidation';
import { FILE_CONSTANTS } from '@/lib/constants';

export const runtime = 'nodejs';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const Body = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('decision'),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    decision: z.enum(['approved', 'rejected']),
  }),
  z.strictObject({
    kind: z.literal('action'),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    action: z.enum([
      'images',
      'confirm_images',
      'initial_idea',
      'dismiss_initial_idea',
      'word_deck_access',
    ]),
    assets: z.array(AssetReference).max(100).optional(),
    expected_revision: z.number().int().positive().optional(),
  }),
]);
function problem(error: { message?: string; code?: string }) {
  const conflict =
    error.message?.includes('revision_conflict') ||
    error.message?.includes('review_expired');
  return NextResponse.json(
    {
      error: {
        code: conflict ? 'review_refresh_required' : 'operation_unavailable',
        message: conflict
          ? '内容或审核已变化，请重新加载差异后再确认。'
          : '操作不可用，请确认资源仍存在且属于当前账号。',
      },
    },
    { status: conflict ? 409 : 403 }
  );
}
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success)
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const nonce = randomBytes(32).toString('base64url');
  const { data, error } = await (supabase as any).rpc(
    'preview_mcp_operation_v2',
    { p_operation_id: id.data, p_nonce_hash: hash(nonce) }
  );
  if (error) return problem(error);
  const assets = [
    ...(data.before?.assets ?? []),
    ...(data.before?.solution_assets ?? []),
  ];
  const { data: urls } = assets.length
    ? await supabase.storage
        .from(FILE_CONSTANTS.STORAGE.BUCKET)
        .createSignedUrls(
          assets.map((a: { path: string }) => a.path),
          900
        )
    : { data: [] };
  return NextResponse.json(
    {
      data: {
        ...data,
        nonce,
        images: assets.map((a: { path: string; role?: string }, i: number) => ({
          path: a.path,
          role: a.role ?? 'question',
          url: urls?.[i]?.signedUrl ?? null,
        })),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
export async function POST(
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
    return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
  const value = body.data;
  const rpcArgs: Record<string, unknown> = {
    p_operation_id: id.data,
    p_nonce_hash: hash(value.nonce),
  };
  let rpc = 'decide_mcp_operation_v2';
  if (value.kind === 'decision') rpcArgs.p_decision = value.decision;
  else {
    rpc = 'complete_mcp_user_action_v2';
    rpcArgs.p_action = value.action;
    const assets = value.assets ?? [];
    // Validate before any storage derivation, then SQL validates existing objects again.
    if (
      assets.some(
        a =>
          !a.path.startsWith(`user/${user.id}/`) ||
          a.path.includes('..') ||
          a.path.includes('\\')
      )
    )
      return NextResponse.json({ error: 'Asset not owned' }, { status: 403 });
    rpcArgs.p_assets =
      value.action === 'images'
        ? await deriveProblemImageAssets(
            assets.map(a => ({ ...a, kind: 'image' as const }))
          )
        : [];
    rpcArgs.p_expected_revision = value.expected_revision ?? null;
  }
  const { data, error } = await (supabase as any).rpc(rpc, rpcArgs);
  if (error) return problem(error);
  // Cache invalidation is after the durable commit; it cannot turn a receipt into failure.
  try {
    const { data: op } = await (supabase as any).rpc(
      'preview_mcp_operation_v2',
      { p_operation_id: id.data, p_nonce_hash: hash(value.nonce) }
    );
    if (op?.resource_type === 'problem' && op.before?.subject_id)
      await revalidateProblemComprehensive(
        op.resource_id,
        op.before.subject_id,
        user.id
      );
  } catch {
    /* A subsequent read refreshes from the DB. */
  }
  return NextResponse.json(
    { data },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
