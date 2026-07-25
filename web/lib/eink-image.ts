import { createHash } from 'crypto';
import { crc32 } from 'zlib';
import sharp, { type Metadata } from 'sharp';

// E-ink image rendering shared by note attachments today and (future) problem
// images. Converts an uploaded photo into the exact framebuffer bytes the
// ZecTrix Note4 panel displays, so the device never decodes or scales images.
//
// Pipeline (deliberately deterministic, no dithering/OCR/cropping):
//   EXIF orient -> flatten onto white -> grayscale -> contain-fit into
//   400x300 on a white canvas -> fixed threshold -> 1-bpp pack -> WQNI file.
//
// Bit layout matches the wqn_epd framebuffer: row-major, 50 bytes per row,
// MSB-first (bit 7 = leftmost pixel), 1 = white, 0 = black.

export const EINK_IMAGE_WIDTH = 400;
export const EINK_IMAGE_HEIGHT = 300;
export const EINK_IMAGE_ROW_BYTES = EINK_IMAGE_WIDTH / 8; // 50
export const EINK_IMAGE_PAYLOAD_BYTES =
  EINK_IMAGE_ROW_BYTES * EINK_IMAGE_HEIGHT; // 15000

// Tuning start point per the design doc; a server-side constant so real
// exam-photo comparisons can adjust it without touching the contract.
export const EINK_IMAGE_THRESHOLD = 180;

export const EINK_IMAGE_MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10MB
export const EINK_IMAGE_MAX_INPUT_PIXELS = 40_000_000; // 40MP

// WQNI container: 20-byte little-endian header + raw payload.
//   magic "WQNI" | version u8 | pixel_format u8 | flags u16 |
//   width u16 | height u16 | payload_length u32 | crc32 u32 | payload
export const WQNI_MAGIC = 'WQNI';
export const WQNI_VERSION = 1;
export const WQNI_PIXEL_FORMAT_BW1 = 1;
// bit0: MSB-first bit order; bit1: bit value 1 renders white.
export const WQNI_FLAGS_MSB_FIRST_ONE_WHITE = 0x0003;
export const WQNI_HEADER_BYTES = 20;

const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export class EinkImageError extends Error {
  constructor(
    public readonly code:
      'unsupported_format' | 'input_too_large' | 'invalid_image',
    message: string
  ) {
    super(message);
    this.name = 'EinkImageError';
  }
}

export interface EinkImageResult {
  /** Device-ready WQNI file (header + 15000-byte 1-bpp payload). */
  wqni: Buffer;
  /** Strict 400x300 black/white PNG rendered from the binarized payload. */
  preview: Buffer;
  /** SHA-256 hex of the full WQNI file; doubles as the stable image id. */
  imageId: string;
}

/** Packs an 8-bit grayscale 400x300 buffer into the 1-bpp payload. */
export function packGrayscaleTo1Bpp(
  gray: Buffer,
  threshold = EINK_IMAGE_THRESHOLD
): Buffer {
  const packed = Buffer.alloc(EINK_IMAGE_PAYLOAD_BYTES);
  for (let y = 0; y < EINK_IMAGE_HEIGHT; y++) {
    const rowIn = y * EINK_IMAGE_WIDTH;
    const rowOut = y * EINK_IMAGE_ROW_BYTES;
    for (let x = 0; x < EINK_IMAGE_WIDTH; x++) {
      if (gray[rowIn + x] >= threshold) {
        packed[rowOut + (x >> 3)] |= 0x80 >> (x & 7); // 1 = white, MSB first
      }
    }
  }
  return packed;
}

/** Wraps a 1-bpp payload in the WQNI container. */
export function buildWqniFile(payload: Buffer): Buffer {
  if (payload.length !== EINK_IMAGE_PAYLOAD_BYTES) {
    throw new EinkImageError(
      'invalid_image',
      `payload must be ${EINK_IMAGE_PAYLOAD_BYTES} bytes`
    );
  }
  const header = Buffer.alloc(WQNI_HEADER_BYTES);
  header.write(WQNI_MAGIC, 0, 'ascii');
  header.writeUInt8(WQNI_VERSION, 4);
  header.writeUInt8(WQNI_PIXEL_FORMAT_BW1, 5);
  header.writeUInt16LE(WQNI_FLAGS_MSB_FIRST_ONE_WHITE, 6);
  header.writeUInt16LE(EINK_IMAGE_WIDTH, 8);
  header.writeUInt16LE(EINK_IMAGE_HEIGHT, 10);
  header.writeUInt32LE(EINK_IMAGE_PAYLOAD_BYTES, 12);
  header.writeUInt32LE(crc32(payload) >>> 0, 16);
  return Buffer.concat([header, payload]);
}

/** Expands the 1-bpp payload back to 8-bit grayscale (for the preview PNG). */
function unpack1BppToGrayscale(payload: Buffer): Buffer {
  const gray = Buffer.alloc(EINK_IMAGE_WIDTH * EINK_IMAGE_HEIGHT);
  for (let y = 0; y < EINK_IMAGE_HEIGHT; y++) {
    const rowIn = y * EINK_IMAGE_ROW_BYTES;
    const rowOut = y * EINK_IMAGE_WIDTH;
    for (let x = 0; x < EINK_IMAGE_WIDTH; x++) {
      const white = (payload[rowIn + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      gray[rowOut + x] = white ? 255 : 0;
    }
  }
  return gray;
}

export async function renderEinkImage(
  input: Buffer,
  threshold = EINK_IMAGE_THRESHOLD
): Promise<EinkImageResult> {
  if (input.length === 0 || input.length > EINK_IMAGE_MAX_INPUT_BYTES) {
    throw new EinkImageError(
      'input_too_large',
      `input must be 1..${EINK_IMAGE_MAX_INPUT_BYTES} bytes`
    );
  }

  // Format decisions come from the actual bytes (sharp probes the content),
  // never from a filename or client-declared MIME type.
  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      limitInputPixels: EINK_IMAGE_MAX_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new EinkImageError('invalid_image', 'unreadable image');
  }
  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    throw new EinkImageError(
      'unsupported_format',
      `unsupported format: ${metadata.format ?? 'unknown'}`
    );
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new EinkImageError('unsupported_format', 'animated images rejected');
  }
  if (!metadata.width || !metadata.height) {
    throw new EinkImageError('invalid_image', 'missing dimensions');
  }
  if (metadata.width * metadata.height > EINK_IMAGE_MAX_INPUT_PIXELS) {
    throw new EinkImageError('input_too_large', 'too many pixels');
  }

  // Scale in grayscale, binarize only on the final canvas: thresholding first
  // and then interpolating would re-introduce gray pixels and break strokes.
  let gray: Buffer;
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: EINK_IMAGE_MAX_INPUT_PIXELS,
    })
      .rotate() // honor EXIF orientation, then drop it
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .grayscale()
      .resize(EINK_IMAGE_WIDTH, EINK_IMAGE_HEIGHT, {
        fit: 'contain', // keep aspect ratio, never crop or stretch
        background: { r: 255, g: 255, b: 255 },
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.width !== EINK_IMAGE_WIDTH ||
      info.height !== EINK_IMAGE_HEIGHT ||
      info.channels !== 1
    ) {
      throw new Error('unexpected raw geometry');
    }
    gray = data;
  } catch (error) {
    if (error instanceof EinkImageError) throw error;
    throw new EinkImageError('invalid_image', 'image decode failed');
  }

  const payload = packGrayscaleTo1Bpp(gray, threshold);
  const wqni = buildWqniFile(payload);

  // The preview must come from the binarized payload so what the user sees on
  // the web matches the panel pixel-for-pixel.
  const preview = await sharp(unpack1BppToGrayscale(payload), {
    raw: {
      width: EINK_IMAGE_WIDTH,
      height: EINK_IMAGE_HEIGHT,
      channels: 1,
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    wqni,
    preview,
    imageId: createHash('sha256').update(wqni).digest('hex'),
  };
}
