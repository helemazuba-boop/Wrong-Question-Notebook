import sharp, { type Metadata } from 'sharp';

export const PROBLEM_IMAGE_INPUT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type ProblemImageInputMimeType =
  (typeof PROBLEM_IMAGE_INPUT_MIME_TYPES)[number];

export interface RawProblemImageInput {
  data: string;
  mime_type: ProblemImageInputMimeType;
}

export interface NormalizedProblemImageInput extends RawProblemImageInput {
  mime_type: 'image/jpeg';
  width: number;
  height: number;
  original_mime_type: ProblemImageInputMimeType;
  original_byte_size: number;
  normalized_byte_size: number;
}

export const PROBLEM_IMAGE_MAX_COUNT = 4;
export const PROBLEM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PROBLEM_IMAGES_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const PROBLEM_IMAGE_MAX_PIXELS = 12_000_000;
export const PROBLEM_IMAGE_MAX_DIMENSION = 8191;
export const PROBLEM_IMAGE_MIN_DIMENSION = 16;
export const PROBLEM_IMAGE_MAX_ASPECT_RATIO = 50;
export const PROBLEM_IMAGE_MAX_BASE64_CHARS =
  Math.ceil(PROBLEM_IMAGE_MAX_BYTES / 3) * 4 + 4;

const FORMAT_MIME: Record<string, ProblemImageInputMimeType | undefined> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export class ProblemImageInputError extends Error {
  constructor(
    public readonly code:
      | 'invalid_images'
      | 'invalid_image'
      | 'image_too_large'
      | 'images_too_large',
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ProblemImageInputError';
  }
}

function decodeCanonicalBase64(data: string): Buffer {
  if (data.length > PROBLEM_IMAGE_MAX_BASE64_CHARS) {
    throw new ProblemImageInputError(
      'image_too_large',
      'Each image must be 5MB or smaller',
      413
    );
  }
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data
    )
  ) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image data is not canonical base64',
      400
    );
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== data) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image data is not canonical base64',
      400
    );
  }
  return decoded;
}

function effectiveDimensions(metadata: Metadata): {
  width: number;
  height: number;
} {
  if (!metadata.width || !metadata.height) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image dimensions are missing',
      400
    );
  }
  const swaps = (metadata.orientation ?? 1) >= 5;
  return swaps
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function validateGeometry(width: number, height: number): void {
  if (
    width < PROBLEM_IMAGE_MIN_DIMENSION ||
    height < PROBLEM_IMAGE_MIN_DIMENSION ||
    width > PROBLEM_IMAGE_MAX_DIMENSION ||
    height > PROBLEM_IMAGE_MAX_DIMENSION ||
    width * height > PROBLEM_IMAGE_MAX_PIXELS ||
    Math.max(width / height, height / width) >= PROBLEM_IMAGE_MAX_ASPECT_RATIO
  ) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image dimensions or aspect ratio are unsupported',
      400
    );
  }
}

async function encodeProviderJpeg(input: Buffer): Promise<Buffer> {
  const attempts = [
    { maxDimension: 4096, quality: 92 },
    { maxDimension: 3200, quality: 86 },
    { maxDimension: 2560, quality: 80 },
    { maxDimension: 2048, quality: 74 },
  ];
  for (const attempt of attempts) {
    const output = await sharp(input, {
      limitInputPixels: PROBLEM_IMAGE_MAX_PIXELS,
    })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize({
        width: attempt.maxDimension,
        height: attempt.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: attempt.quality,
        chromaSubsampling: '4:4:4',
        mozjpeg: true,
      })
      .toBuffer();
    if (output.length <= PROBLEM_IMAGE_MAX_BYTES) return output;
  }
  throw new ProblemImageInputError(
    'image_too_large',
    'Normalized image is larger than 5MB',
    413
  );
}

async function normalizeOne(
  image: RawProblemImageInput
): Promise<NormalizedProblemImageInput> {
  if (!PROBLEM_IMAGE_INPUT_MIME_TYPES.includes(image.mime_type)) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image MIME type is unsupported',
      400
    );
  }
  const decoded = decodeCanonicalBase64(image.data);
  if (decoded.length > PROBLEM_IMAGE_MAX_BYTES) {
    throw new ProblemImageInputError(
      'image_too_large',
      'Each image must be 5MB or smaller',
      413
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(decoded, {
      limitInputPixels: PROBLEM_IMAGE_MAX_PIXELS,
    }).metadata();
  } catch {
    throw new ProblemImageInputError(
      'invalid_image',
      'Image bytes are unreadable',
      400
    );
  }
  const actualMime = metadata.format ? FORMAT_MIME[metadata.format] : undefined;
  if (!actualMime || actualMime !== image.mime_type) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Declared MIME type does not match image bytes',
      400
    );
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Animated or multi-page images are unsupported',
      400
    );
  }
  const dimensions = effectiveDimensions(metadata);
  validateGeometry(dimensions.width, dimensions.height);

  let normalized: Buffer;
  try {
    normalized = await encodeProviderJpeg(decoded);
  } catch (error) {
    if (error instanceof ProblemImageInputError) throw error;
    throw new ProblemImageInputError(
      'invalid_image',
      'Image normalization failed',
      400
    );
  }
  const normalizedMetadata = await sharp(normalized).metadata();
  if (!normalizedMetadata.width || !normalizedMetadata.height) {
    throw new ProblemImageInputError(
      'invalid_image',
      'Normalized image dimensions are missing',
      400
    );
  }
  return {
    data: normalized.toString('base64'),
    mime_type: 'image/jpeg',
    width: normalizedMetadata.width,
    height: normalizedMetadata.height,
    original_mime_type: image.mime_type,
    original_byte_size: decoded.length,
    normalized_byte_size: normalized.length,
  };
}

export async function normalizeProblemImageInputs(
  images: RawProblemImageInput[]
): Promise<NormalizedProblemImageInput[]> {
  if (images.length < 1 || images.length > PROBLEM_IMAGE_MAX_COUNT) {
    throw new ProblemImageInputError(
      'invalid_images',
      `Provide between 1 and ${PROBLEM_IMAGE_MAX_COUNT} images`,
      400
    );
  }
  const normalized = await Promise.all(images.map(normalizeOne));
  const total = normalized.reduce(
    (sum, image) => sum + image.normalized_byte_size,
    0
  );
  if (total > PROBLEM_IMAGES_MAX_TOTAL_BYTES) {
    throw new ProblemImageInputError(
      'images_too_large',
      'Combined normalized image size must be 10MB or smaller',
      413
    );
  }
  return normalized;
}
