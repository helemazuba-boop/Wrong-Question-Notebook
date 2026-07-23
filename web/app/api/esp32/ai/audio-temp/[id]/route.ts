import { NextRequest, NextResponse } from 'next/server';
import {
  AudioStagingError,
  readStagedEsp32AiAudioFile,
} from '@/lib/esp32-ai-audio-staging';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const audio = await readStagedEsp32AiAudioFile(id, new URL(req.url));
    const body = audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength
    ) as ArrayBuffer;

    logger.info('ESP32 AI temporary WAV downloaded', {
      component: 'Esp32AiAudioStaging',
      audioId: id,
      wavBytes: audio.byteLength,
      userAgent: (req.headers.get('user-agent') || '').slice(0, 160),
    });

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof AudioStagingError) {
      logger.warn('ESP32 AI temporary WAV download rejected', {
        component: 'Esp32AiAudioStaging',
        audioId: id,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.status }
      );
    }

    logger.error('ESP32 AI temporary WAV download failed', error, {
      component: 'Esp32AiAudioStaging',
      audioId: id,
    });

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'audio_temp_failed',
          message: 'Audio file request failed',
        },
      },
      { status: 500 }
    );
  }
}
