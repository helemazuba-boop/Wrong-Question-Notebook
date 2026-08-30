import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  isValidUuid,
} from '@/lib/common-utils';
import { QR_SESSION_CONSTANTS } from '@/lib/constants';
import type { QRSessionConsumeResponse } from '@/lib/types';

async function consumeSession(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  const { sessionId } = await params;

  if (!isValidUuid(sessionId)) {
    return NextResponse.json(
      createApiErrorResponse('Invalid session ID', 400),
      { status: 400 }
    );
  }

  const serviceClient = createServiceClient();

  try {
    // Fetch session and verify ownership
    const { data: session, error: fetchError } = await serviceClient
      .from('qr_upload_sessions')
      .select('user_id, status, file_path, mime_type, expires_at')
      .eq('id', sessionId)
      .single();

    if (fetchError || !session) {
      return NextResponse.json(
        createApiErrorResponse(
          QR_SESSION_CONSTANTS.ERRORS.SESSION_NOT_FOUND,
          404
        ),
        { status: 404 }
      );
    }

    // Ownership check
    if (session.user_id !== user.id) {
      return NextResponse.json(createApiErrorResponse('Forbidden', 403), {
        status: 403,
      });
    }

    const now = new Date().toISOString();
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      const { error: expiryError } = await serviceClient
        .from('qr_upload_sessions')
        .update({ status: 'expired' })
        .eq('id', sessionId)
        .in('status', ['pending', 'uploaded']);
      if (expiryError) {
        console.error('Failed to persist expired QR session:', expiryError);
      }
      return NextResponse.json(
        createApiErrorResponse(
          QR_SESSION_CONSTANTS.ERRORS.SESSION_EXPIRED,
          410
        ),
        { status: 410 }
      );
    }

    if (session.status !== 'uploaded') {
      return NextResponse.json(
        createApiErrorResponse(QR_SESSION_CONSTANTS.ERRORS.NOT_UPLOADED, 400),
        { status: 400 }
      );
    }
    if (!session.file_path || !session.mime_type) {
      console.error('Uploaded QR session is missing its object metadata');
      return NextResponse.json(
        createApiErrorResponse('Uploaded file metadata is missing', 500),
        { status: 500 }
      );
    }

    // Transition to consumed
    const { data: consumed, error: updateError } = await serviceClient
      .from('qr_upload_sessions')
      .update({
        status: 'consumed',
        consumed_at: now,
      })
      .eq('id', sessionId)
      .eq('status', 'uploaded')
      .gt('expires_at', now)
      .select('file_path, mime_type')
      .maybeSingle();

    if (updateError) {
      console.error('QR session consume error:', updateError);
      return NextResponse.json(
        createApiErrorResponse('Failed to consume session', 500),
        { status: 500 }
      );
    }
    if (!consumed) {
      const expired = new Date(session.expires_at).getTime() <= Date.now();
      if (expired) {
        const { error: expiryError } = await serviceClient
          .from('qr_upload_sessions')
          .update({ status: 'expired' })
          .eq('id', sessionId)
          .eq('status', 'uploaded');
        if (expiryError) {
          console.error('Failed to persist expired QR session:', expiryError);
        }
      }
      return NextResponse.json(
        createApiErrorResponse(
          expired
            ? QR_SESSION_CONSTANTS.ERRORS.SESSION_EXPIRED
            : QR_SESSION_CONSTANTS.ERRORS.SESSION_ALREADY_USED,
          expired ? 410 : 409
        ),
        { status: expired ? 410 : 409 }
      );
    }
    if (!consumed.file_path || !consumed.mime_type) {
      console.error('Consumed QR session is missing its uploaded object');
      return NextResponse.json(
        createApiErrorResponse('Uploaded file metadata is missing', 500),
        { status: 500 }
      );
    }

    const response: QRSessionConsumeResponse = {
      filePath: consumed.file_path,
      mimeType: consumed.mime_type,
    };

    return NextResponse.json(createApiSuccessResponse(response));
  } catch (error) {
    console.error('QR session consume error:', error);
    return NextResponse.json(
      createApiErrorResponse('Internal server error', 500),
      { status: 500 }
    );
  }
}

export const POST = withSecurity(consumeSession, {
  rateLimitType: 'api',
});
