import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { QR_SESSION_CONSTANTS } from '@/lib/constants';
import type { QRSessionCreateResponse } from '@/lib/types';
import { cleanupStaleQrUploadSessions } from '@/lib/qr-upload-cleanup';

function publicSiteOrigin(req: Request): string {
  const configuredOrigin = process.env.SITE_URL?.trim();
  if (process.env.NODE_ENV === 'production' && !configuredOrigin) {
    throw new Error('SITE_URL is required in production');
  }
  const url = new URL(configuredOrigin || req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('SITE_URL must use http or https');
  }
  return url.origin;
}

async function createSession(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  try {
    const siteOrigin = publicSiteOrigin(req);
    // The hourly cron is authoritative; this bounded pass prevents stale data
    // from lingering when cron is temporarily unavailable.
    try {
      await cleanupStaleQrUploadSessions();
    } catch (cleanupError) {
      console.error('Best-effort QR upload cleanup failed:', cleanupError);
    }

    // Generate token
    const rawToken = crypto
      .randomBytes(QR_SESSION_CONSTANTS.TOKEN_BYTES)
      .toString('base64url');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    // Insert session
    const expiresAt = new Date(
      Date.now() + QR_SESSION_CONSTANTS.SESSION_EXPIRY_MINUTES * 60 * 1000
    ).toISOString();

    const { data: session, error } = await supabase
      .from('qr_upload_sessions')
      .insert({
        user_id: user.id,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id, expires_at')
      .single();

    if (error || !session) {
      console.error('Failed to create QR session:', error);
      return NextResponse.json(
        createApiErrorResponse('Failed to create session', 500),
        { status: 500 }
      );
    }

    // Build upload URL
    // URL fragments are not sent in HTTP requests or proxy access logs. The
    // mobile client moves this token into a request header before upload.
    const uploadUrl = `${siteOrigin}/upload/${session.id}#token=${rawToken}`;

    const response: QRSessionCreateResponse = {
      sessionId: session.id,
      expiresAt: session.expires_at,
      uploadUrl,
    };

    return NextResponse.json(createApiSuccessResponse(response));
  } catch (error) {
    console.error('QR session creation error:', error);
    return NextResponse.json(
      createApiErrorResponse('Internal server error', 500),
      { status: 500 }
    );
  }
}

export const POST = withSecurity(createSession, {
  rateLimitType: 'custom',
  customRateLimit: QR_SESSION_CONSTANTS.RATE_LIMITS.SESSION_CREATION,
});
