import { NextResponse } from 'next/server';
import {
  cleanupStaleQrUploadSessions,
  QR_UPLOAD_CLEANUP_BATCH_SIZE,
} from '@/lib/qr-upload-cleanup';

const MAX_BATCHES_PER_RUN = 10;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let deleted = 0;
    let batches = 0;
    while (batches < MAX_BATCHES_PER_RUN) {
      const count = await cleanupStaleQrUploadSessions();
      deleted += count;
      batches += 1;
      if (count < QR_UPLOAD_CLEANUP_BATCH_SIZE) break;
    }
    return NextResponse.json({ deleted, batches });
  } catch (error) {
    console.error('QR upload cleanup cron failed:', error);
    return NextResponse.json(
      { error: 'QR upload cleanup failed' },
      { status: 500 }
    );
  }
}
