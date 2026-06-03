import { NextRequest, NextResponse } from 'next/server';
import {
  AudioStagingError,
  readStagedEsp32AiAudioFile,
} from '@/lib/esp32-ai-audio-staging';

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
