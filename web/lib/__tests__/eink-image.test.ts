import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  EINK_IMAGE_PAYLOAD_BYTES,
  EINK_IMAGE_ROW_BYTES,
  EinkImageError,
  WQNI_HEADER_BYTES,
  buildWqniFile,
  packGrayscaleTo1Bpp,
  renderEinkImage,
} from '@/lib/eink-image';

function solidPng(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number }
) {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .png()
    .toBuffer();
}

/** Payload byte offset for pixel (x, y). */
function byteAt(payload: Buffer, x: number, y: number) {
  return payload[y * EINK_IMAGE_ROW_BYTES + (x >> 3)];
}

function payloadOf(wqni: Buffer) {
  return wqni.subarray(WQNI_HEADER_BYTES);
}

describe('eink-image', () => {
  it('packs MSB-first with 1=white and honors the fixed threshold boundary', () => {
    const gray = Buffer.alloc(400 * 300, 180); // exactly at threshold -> white
    gray[0] = 179; // below threshold -> black, pixel (0,0)
    const payload = packGrayscaleTo1Bpp(gray);
    expect(payload.length).toBe(EINK_IMAGE_PAYLOAD_BYTES);
    // Pixel (0,0) black clears bit7 of byte 0; the rest of the byte is white.
    expect(payload[0]).toBe(0x7f);
    expect(payload[1]).toBe(0xff);
    expect(payload[EINK_IMAGE_PAYLOAD_BYTES - 1]).toBe(0xff);
  });

  it('builds a WQNI file with a valid header and CRC32', () => {
    const payload = Buffer.alloc(EINK_IMAGE_PAYLOAD_BYTES, 0xff);
    const wqni = buildWqniFile(payload);
    expect(wqni.length).toBe(WQNI_HEADER_BYTES + EINK_IMAGE_PAYLOAD_BYTES);
    expect(wqni.subarray(0, 4).toString('ascii')).toBe('WQNI');
    expect(wqni.readUInt8(4)).toBe(1); // version
    expect(wqni.readUInt8(5)).toBe(1); // pixel_format BW1
    expect(wqni.readUInt16LE(6)).toBe(0x0003); // MSB-first, 1=white
    expect(wqni.readUInt16LE(8)).toBe(400);
    expect(wqni.readUInt16LE(10)).toBe(300);
    expect(wqni.readUInt32LE(12)).toBe(EINK_IMAGE_PAYLOAD_BYTES);
    expect(wqni.readUInt32LE(16)).toBe(crc32(payload) >>> 0);
    expect(() => buildWqniFile(Buffer.alloc(10))).toThrow(EinkImageError);
  });

  it('renders a black image as an all-black canvas with a stable image id', async () => {
    const input = await solidPng(400, 300, { r: 0, g: 0, b: 0 });
    const first = await renderEinkImage(input);
    const second = await renderEinkImage(input);
    const payload = payloadOf(first.wqni);
    expect(payload.every(byte => byte === 0x00)).toBe(true);
    expect(first.imageId).toBe(
      createHash('sha256').update(first.wqni).digest('hex')
    );
    expect(second.imageId).toBe(first.imageId); // deterministic pipeline
  });

  it('contain-fits without cropping and pads with white', async () => {
    // 800x400 black -> scaled to 400x200, centered: 50 white rows top/bottom.
    const input = await solidPng(800, 400, { r: 0, g: 0, b: 0 });
    const { wqni } = await renderEinkImage(input);
    const payload = payloadOf(wqni);
    expect(byteAt(payload, 200, 10)).toBe(0xff); // top padding is white
    expect(byteAt(payload, 200, 150)).toBe(0x00); // center is black
    expect(byteAt(payload, 200, 290)).toBe(0xff); // bottom padding is white
  });

  it('flattens transparency onto white instead of black', async () => {
    const transparent = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const { wqni } = await renderEinkImage(transparent);
    expect(payloadOf(wqni).every(byte => byte === 0xff)).toBe(true);
  });

  it('honors EXIF orientation before scaling', async () => {
    // 40x30, left half black; orientation=3 (180 degrees) puts black on the
    // right after auto-orient. Sample away from the seam to dodge JPEG noise.
    const left = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 20,
              height: 30,
              channels: 3,
              background: { r: 0, g: 0, b: 0 },
            },
          },
          left: 0,
          top: 0,
        },
      ])
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 3 })
      .toBuffer();
    const { wqni } = await renderEinkImage(left);
    const payload = payloadOf(wqni);
    expect(byteAt(payload, 40, 150)).toBe(0xff); // far left now white
    expect(byteAt(payload, 360, 150)).toBe(0x00); // far right now black
  });

  it('rotates portrait sources 90deg counterclockwise before the contain fit', async () => {
    // 100x200 portrait, top half black. Rotated 90deg CCW the top edge
    // becomes the LEFT edge: 200x100 with the left half black, scaled x2 to
    // 400x200 and centered with 50 white rows top/bottom.
    const portrait = await sharp({
      create: {
        width: 100,
        height: 200,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 100,
              height: 100,
              channels: 3,
              background: { r: 0, g: 0, b: 0 },
            },
          },
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const { wqni } = await renderEinkImage(portrait);
    const payload = payloadOf(wqni);
    expect(byteAt(payload, 200, 10)).toBe(0xff); // vertical padding stays white
    expect(byteAt(payload, 100, 150)).toBe(0x00); // left half black (was top)
    expect(byteAt(payload, 300, 150)).toBe(0xff); // right half white (was bottom)
    expect(byteAt(payload, 200, 290)).toBe(0xff);
  });

  it('rotates EXIF-portrait sources via the orientation pre-pass', async () => {
    // Stored landscape 200x100 (left half black) + orientation=6 (90deg CW on
    // display) = an effective portrait whose TOP half is black. Our CCW
    // rotation must then bring the black back to the LEFT edge.
    const exifPortrait = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 100,
              height: 100,
              channels: 3,
              background: { r: 0, g: 0, b: 0 },
            },
          },
          left: 0,
          top: 0,
        },
      ])
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { wqni } = await renderEinkImage(exifPortrait);
    const payload = payloadOf(wqni);
    expect(byteAt(payload, 100, 150)).toBe(0x00);
    expect(byteAt(payload, 300, 150)).toBe(0xff);
  });

  it('rejects unsupported and invalid inputs', async () => {
    const gif = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .gif()
      .toBuffer();
    await expect(renderEinkImage(gif)).rejects.toMatchObject({
      code: 'unsupported_format',
    });
    await expect(
      renderEinkImage(Buffer.from('not an image'))
    ).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(renderEinkImage(Buffer.alloc(0))).rejects.toMatchObject({
      code: 'input_too_large',
    });
    await expect(
      renderEinkImage(Buffer.alloc(10 * 1024 * 1024 + 1))
    ).rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('produces a preview PNG that matches the binarized geometry', async () => {
    const input = await solidPng(400, 300, { r: 0, g: 0, b: 0 });
    const { preview } = await renderEinkImage(input);
    const meta = await sharp(preview).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
    const stats = await sharp(preview).stats();
    expect(stats.channels[0].max).toBe(0); // pure black preview
  });
});
