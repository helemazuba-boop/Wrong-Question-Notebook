import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withSecurity } from '@/lib/security-middleware';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
  isValidUuid,
} from '@/lib/common-utils';
import { QR_SESSION_CONSTANTS, FILE_CONSTANTS } from '@/lib/constants';
import {
  normalizeProblemImageInputs,
  ProblemImageInputError,
  type ProblemImageInputMimeType,
} from '@/lib/image-input-normalization';

function verifyToken(rawToken: string, storedHash: string): boolean {
  const computedHash = crypto
    .createHash('sha256')
    .update(rawToken)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(storedHash, 'hex')
    );
  } catch {
    return false;
  }
}

async function handlePhoneUpload(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  if (!isValidUuid(sessionId)) {
    return NextResponse.json(
      createApiErrorResponse('Invalid session ID', 400),
      { status: 400 }
    );
  }

  const token = req.headers.get('x-wqn-qr-token') ?? '';
  if (!token || token.length > 256) {
    return NextResponse.json(
      createApiErrorResponse(QR_SESSION_CONSTANTS.ERRORS.INVALID_TOKEN, 403),
      { status: 403 }
    );
  }

  const serviceClient = createServiceClient();

  try {
    // Fetch session
    const { data: session, error: fetchError } = await serviceClient
      .from('qr_upload_sessions')
      .select('*')
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

    // Verify token
    if (!verifyToken(token, session.token_hash)) {
      return NextResponse.json(
        createApiErrorResponse(QR_SESSION_CONSTANTS.ERRORS.INVALID_TOKEN, 403),
        { status: 403 }
      );
    }

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
      const { error: expiryError } = await serviceClient
        .from('qr_upload_sessions')
        .update({ status: 'expired' })
        .eq('id', sessionId)
        .in('status', ['pending', 'uploaded']);
      if (expiryError) {
        console.error('Failed to persist expired QR upload:', expiryError);
      }
      return NextResponse.json(
        createApiErrorResponse(
          QR_SESSION_CONSTANTS.ERRORS.SESSION_EXPIRED,
          410
        ),
        { status: 410 }
      );
    }

    // Check status
    if (session.status !== 'pending') {
      return NextResponse.json(
        createApiErrorResponse(
          QR_SESSION_CONSTANTS.ERRORS.SESSION_ALREADY_USED,
          409
        ),
        { status: 409 }
      );
    }

    // Parse form data
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        createApiErrorResponse('Invalid form data', 400),
        { status: 400 }
      );
    }

    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json(
        createApiErrorResponse('No file provided', 400),
        { status: 400 }
      );
    }

    // Validate MIME type
    if (
      !(QR_SESSION_CONSTANTS.ALLOWED_MIME_TYPES as readonly string[]).includes(
        file.type
      )
    ) {
      return NextResponse.json(
        createApiErrorResponse(
          QR_SESSION_CONSTANTS.ERRORS.INVALID_FILE_TYPE,
          400
        ),
        { status: 400 }
      );
    }

    // Validate size
    if (file.size > QR_SESSION_CONSTANTS.MAX_FILE_SIZE) {
      return NextResponse.json(
        createApiErrorResponse(QR_SESSION_CONSTANTS.ERRORS.FILE_TOO_LARGE, 413),
        { status: 413 }
      );
    }

    const sourceBuffer = Buffer.from(await file.arrayBuffer());
    let normalizedBuffer: Buffer;
    try {
      const [normalized] = await normalizeProblemImageInputs([
        {
          data: sourceBuffer.toString('base64'),
          mime_type: file.type as ProblemImageInputMimeType,
        },
      ]);
      normalizedBuffer = Buffer.from(normalized.data, 'base64');
    } catch (error) {
      if (error instanceof ProblemImageInputError) {
        return NextResponse.json(
          createApiErrorResponse(error.message, error.status),
          { status: error.status }
        );
      }
      throw error;
    }

    // Every attempt gets an independent object. A losing concurrent upload can
    // therefore clean up its own file without deleting the winning object.
    const attemptId = crypto.randomBytes(12).toString('hex');
    const storagePath = `user/${session.user_id}/${QR_SESSION_CONSTANTS.STORAGE_PATH_PREFIX}/${sessionId}/photo-${attemptId}.jpg`;

    // Upload to storage
    const { error: uploadError } = await serviceClient.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .upload(storagePath, normalizedBuffer, {
        contentType: 'image/jpeg',
        cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
        upsert: false,
      });

    if (uploadError) {
      console.error('QR upload storage error:', uploadError);
      return NextResponse.json(
        createApiErrorResponse('File upload failed', 500),
        { status: 500 }
      );
    }

    // Optimistic concurrency: only update if still pending
    const updateStartedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await serviceClient
      .from('qr_upload_sessions')
      .update({
        status: 'uploaded',
        file_path: storagePath,
        mime_type: 'image/jpeg',
        uploaded_at: updateStartedAt,
      })
      .eq('id', sessionId)
      .eq('status', 'pending')
      .gt('expires_at', updateStartedAt)
      .select('id')
      .maybeSingle();

    if (updateError || !updated) {
      // The row never referenced this attempt's object, so it is always safe
      // to remove regardless of whether this was a conflict or DB failure.
      const { error: cleanupError } = await serviceClient.storage
        .from(FILE_CONSTANTS.STORAGE.BUCKET)
        .remove([storagePath]);
      if (cleanupError) {
        console.error(
          'Failed to clean up uncommitted QR upload:',
          cleanupError
        );
      }

      if (updateError) {
        console.error('QR upload session update failed:', updateError);
        return NextResponse.json(
          createApiErrorResponse('Failed to commit file upload', 500),
          { status: 500 }
        );
      }

      const expired = new Date(session.expires_at) <= new Date();
      if (expired) {
        const { error: expiryError } = await serviceClient
          .from('qr_upload_sessions')
          .update({ status: 'expired' })
          .eq('id', sessionId)
          .eq('status', 'pending');
        if (expiryError) {
          console.error('Failed to persist expired QR upload:', expiryError);
        }
      }
      const status = expired ? 410 : 409;
      const message = expired
        ? QR_SESSION_CONSTANTS.ERRORS.SESSION_EXPIRED
        : QR_SESSION_CONSTANTS.ERRORS.SESSION_ALREADY_USED;
      return NextResponse.json(createApiErrorResponse(message, status), {
        status,
      });
    }

    return NextResponse.json(
      createApiSuccessResponse({ message: 'File uploaded successfully' })
    );
  } catch (error) {
    console.error('QR phone upload error:', error);
    return NextResponse.json(
      createApiErrorResponse('Internal server error', 500),
      { status: 500 }
    );
  }
}

export const POST = withSecurity(handlePhoneUpload, {
  rateLimitType: 'fileUpload',
});
