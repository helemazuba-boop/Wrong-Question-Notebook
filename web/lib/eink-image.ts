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
export const EINK_IMAGE_GRAY4_ROW_BYTES = EINK_IMAGE_WIDTH / 2; // 200
export const EINK_IMAGE_GRAY4_PAYLOAD_BYTES =
  EINK_IMAGE_GRAY4_ROW_BYTES * EINK_IMAGE_HEIGHT; // 60000

// Tuning start point per the design doc; a server-side constant so real
// exam-photo comparisons can adjust it without touching the contract.
export const EINK_IMAGE_THRESHOLD = 180;

export const EINK_IMAGE_MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10MB
// 12MP covers every realistic exam-photo source while keeping the worst-case
// sharp RGBA expansion near 48 MB; 40MP inputs decoded to ~160 MB and a couple
// of concurrent uploads could OOM-kill the serverless runtime.
export const EINK_IMAGE_MAX_INPUT_PIXELS = 12_000_000; // 12MP

// WQNI container: 20-byte little-endian header + raw payload.
//   magic "WQNI" | version u8 | pixel_format u8 | flags u16 |
//   width u16 | height u16 | payload_length u32 | crc32 u32 | payload
export const WQNI_MAGIC = 'WQNI';
export const WQNI_VERSION = 1;
export const WQNI_PIXEL_FORMAT_BW1 = 1;
export const WQNI_PIXEL_FORMAT_GRAY4 = 2;
// bit0: MSB-first bit order; bit1: bit value 1 renders white.
export const WQNI_FLAGS_MSB_FIRST_ONE_WHITE = 0x0003;
export const WQNI_HEADER_BYTES = 20;

const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

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
  /** Device-ready 4-bpp/16-gray WQNI file for capable firmware. */
  gray4Wqni: Buffer;
  /** Strict 400x300 PNG reconstructed from the quantized 16-gray payload. */
  gray4Preview: Buffer;
  /** SHA-256 hex of gray4Wqni; independent from the legacy BW1 id. */
  gray4ImageId: string;
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

// Mirrors the reference demo's final tone preparation while retaining WQN's
// contain-fit geometry (cropping an exam sheet is not acceptable). Pillow's
// default autocontrast stretches the occupied range, then Contrast blends
// around the image mean. Keeping this byte-only makes the server output stable
// across Sharp/libvips releases.
export function prepareGrayscaleForGray4(
  gray: Buffer,
  contrast = 1.55
): Buffer {
  if (gray.length !== EINK_IMAGE_WIDTH * EINK_IMAGE_HEIGHT || contrast <= 0) {
    throw new EinkImageError('invalid_image', 'invalid gray4 source');
  }
  // contain-fit padding is synthesized as exact white. Locate the smallest
  // rectangle containing any non-padding pixel so white bars do not dominate
  // autocontrast statistics; an all-white input falls back to the full frame.
  let minX = EINK_IMAGE_WIDTH;
  let minY = EINK_IMAGE_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < EINK_IMAGE_HEIGHT; y++) {
    const row = y * EINK_IMAGE_WIDTH;
    for (let x = 0; x < EINK_IMAGE_WIDTH; x++) {
      if (gray[row + x] < 255) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0;
    minY = 0;
    maxX = EINK_IMAGE_WIDTH - 1;
    maxY = EINK_IMAGE_HEIGHT - 1;
  }

  let minimum = 255;
  let maximum = 0;
  for (let y = minY; y <= maxY; y++) {
    const row = y * EINK_IMAGE_WIDTH;
    for (let x = minX; x <= maxX; x++) {
      const value = gray[row + x];
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const stretched = Buffer.allocUnsafe(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const value = Math.max(
      0,
      Math.min(
        255,
        minimum === maximum
          ? gray[i]
          : Math.round(((gray[i] - minimum) * 255) / (maximum - minimum))
      )
    );
    stretched[i] = value;
  }
  let sum = 0;
  for (let y = minY; y <= maxY; y++) {
    const row = y * EINK_IMAGE_WIDTH;
    for (let x = minX; x <= maxX; x++) {
      sum += stretched[row + x];
    }
  }
  const mean = sum / ((maxX - minX + 1) * (maxY - minY + 1));
  for (let i = 0; i < stretched.length; i++) {
    stretched[i] = Math.max(
      0,
      Math.min(255, Math.round(mean + contrast * (stretched[i] - mean)))
    );
  }
  return stretched;
}

/** Packs two pixels per byte, left pixel in the high nibble, 0=black/15=white. */
export function packGrayscaleTo4Bpp(gray: Buffer): Buffer {
  if (gray.length !== EINK_IMAGE_WIDTH * EINK_IMAGE_HEIGHT) {
    throw new EinkImageError('invalid_image', 'invalid gray4 geometry');
  }
  const packed = Buffer.allocUnsafe(EINK_IMAGE_GRAY4_PAYLOAD_BYTES);
  for (let source = 0, target = 0; source < gray.length; source += 2) {
    const left = Math.floor((gray[source] * 15 + 127) / 255);
    const right = Math.floor((gray[source + 1] * 15 + 127) / 255);
    packed[target++] = (left << 4) | right;
  }
  return packed;
}

/** Wraps a BW1 or GRAY4 payload in the WQNI container. */
export function buildWqniFile(
  payload: Buffer,
  pixelFormat:
    | typeof WQNI_PIXEL_FORMAT_BW1
    | typeof WQNI_PIXEL_FORMAT_GRAY4 = WQNI_PIXEL_FORMAT_BW1
): Buffer {
  const expectedPayloadBytes =
    pixelFormat === WQNI_PIXEL_FORMAT_BW1
      ? EINK_IMAGE_PAYLOAD_BYTES
      : EINK_IMAGE_GRAY4_PAYLOAD_BYTES;
  if (payload.length !== expectedPayloadBytes) {
    throw new EinkImageError(
      'invalid_image',
      `payload must be ${expectedPayloadBytes} bytes`
    );
  }
  const header = Buffer.alloc(WQNI_HEADER_BYTES);
  header.write(WQNI_MAGIC, 0, 'ascii');
  header.writeUInt8(WQNI_VERSION, 4);
  header.writeUInt8(pixelFormat, 5);
  header.writeUInt16LE(WQNI_FLAGS_MSB_FIRST_ONE_WHITE, 6);
  header.writeUInt16LE(EINK_IMAGE_WIDTH, 8);
  header.writeUInt16LE(EINK_IMAGE_HEIGHT, 10);
  header.writeUInt32LE(expectedPayloadBytes, 12);
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

/** Expands high/low 4-bpp nibbles to exact 8-bit preview levels. */
export function unpack4BppToGrayscale(payload: Buffer): Buffer {
  if (payload.length !== EINK_IMAGE_GRAY4_PAYLOAD_BYTES) {
    throw new EinkImageError('invalid_image', 'invalid gray4 payload');
  }
  const gray = Buffer.allocUnsafe(EINK_IMAGE_WIDTH * EINK_IMAGE_HEIGHT);
  for (let source = 0, target = 0; source < payload.length; source++) {
    const packed = payload[source];
    gray[target++] = (packed >> 4) * 17;
    gray[target++] = (packed & 0x0f) * 17;
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
  //
  // Adaptive rotation: the panel is landscape (400x300). A portrait source
  // matched short-edge-to-long-edge and wasted most of the canvas as padding,
  // so portrait inputs are rotated 90deg counterclockwise before the contain
  // fit. EXIF orientation 5-8 swaps the stored dimensions, and sharp honours
  // only ONE rotation per pipeline -- when both EXIF and our rotation apply,
  // a lossless pre-pass bakes the EXIF orientation in first.
  const orientationSwaps = (metadata.orientation ?? 1) >= 5;
  const effectiveWidth = orientationSwaps ? metadata.height : metadata.width;
  const effectiveHeight = orientationSwaps ? metadata.width : metadata.height;
  const isPortrait = effectiveHeight > effectiveWidth;
  let gray: Buffer;
  try {
    let working = input;
    if (isPortrait && (metadata.orientation ?? 1) !== 1) {
      working = await sharp(input, {
        limitInputPixels: EINK_IMAGE_MAX_INPUT_PIXELS,
      })
        .rotate() // bake EXIF orientation, then drop it
        .png()
        .toBuffer();
    }
    const pipeline = sharp(working, {
      limitInputPixels: EINK_IMAGE_MAX_INPUT_PIXELS,
    });
    const { data, info } = await (
      isPortrait
        ? pipeline.rotate(270) // 90deg counterclockwise
        : pipeline.rotate()
    ) // honor EXIF orientation, then drop it
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
  const gray4Payload = packGrayscaleTo4Bpp(prepareGrayscaleForGray4(gray));
  const gray4Wqni = buildWqniFile(gray4Payload, WQNI_PIXEL_FORMAT_GRAY4);

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
  const gray4Preview = await sharp(unpack4BppToGrayscale(gray4Payload), {
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
    gray4Wqni,
    gray4Preview,
    gray4ImageId: createHash('sha256').update(gray4Wqni).digest('hex'),
  };
}
