import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';

// Soft revocation: revoked_at is set instead of deleting the row so the
// token's audit trail (name/created_at/last_used_at) survives.

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const { id } = await params;
  const { data, error } = await supabase
    .from('user_api_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      createApiErrorResponse('Failed to revoke token', 500),
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(createApiErrorResponse('Token not found', 404), {
      status: 404,
    });
  }
  return NextResponse.json(createApiSuccessResponse({ revoked: true }));
}
