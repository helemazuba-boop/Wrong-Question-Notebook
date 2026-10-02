import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  normalizeProblemImageInputs,
  ProblemImageInputError,
} from '@/lib/image-input-normalization';

async function solidPng(width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .png()
    .toBuffer();
}

describe('problem image input normalization', () => {
  it('decodes a real image and emits a bounded provider JPEG', async () => {
    const source = await solidPng(64, 48);
    const [normalized] = await normalizeProblemImageInputs([
      { data: source.toString('base64'), mime_type: 'image/png' },
    ]);

    expect(normalized).toMatchObject({
      mime_type: 'image/jpeg',
      original_mime_type: 'image/png',
      original_byte_size: source.length,
      width: 64,
      height: 48,
    });
    expect(
      await sharp(Buffer.from(normalized.data, 'base64')).metadata()
    ).toMatchObject({ format: 'jpeg', width: 64, height: 48 });
  });

  it('rejects a declared MIME type that does not match the bytes', async () => {
    const source = await solidPng();
    await expect(
      normalizeProblemImageInputs([
        { data: source.toString('base64'), mime_type: 'image/jpeg' },
      ])
    ).rejects.toMatchObject({
      code: 'invalid_image',
      status: 400,
      message: 'Declared MIME type does not match image bytes',
    });
  });

  it('rejects malformed or non-canonical base64', async () => {
    await expect(
      normalizeProblemImageInputs([
        { data: 'not base64', mime_type: 'image/png' },
      ])
    ).rejects.toBeInstanceOf(ProblemImageInputError);
  });

  it('rejects unsafe geometry before provider submission', async () => {
    const tooSmall = await solidPng(15, 32);
    const tooWide = await solidPng(1600, 16);

    for (const source of [tooSmall, tooWide]) {
      await expect(
        normalizeProblemImageInputs([
          { data: source.toString('base64'), mime_type: 'image/png' },
        ])
      ).rejects.toMatchObject({ code: 'invalid_image', status: 400 });
    }
  });

  it('rejects animated images even when their declared MIME is valid', async () => {
    const first = await solidPng();
    const second = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 80, g: 80, b: 80 },
      },
    })
      .png()
      .toBuffer();
    const animated = await sharp([first, second], {
      join: { animated: true },
    })
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer();

    await expect(
      normalizeProblemImageInputs([
        { data: animated.toString('base64'), mime_type: 'image/gif' },
      ])
    ).rejects.toMatchObject({
      code: 'invalid_image',
      message: 'Animated or multi-page images are unsupported',
    });
  });
});
