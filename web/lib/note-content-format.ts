// Frozen note content format for blank-notebook v1.
//
// `plain_text_v1` is the single authoritative storage format shared by the web
// UI, the AI note tools, and (from N3) the Note4 firmware. Freezing it here —
// rather than scattering `.slice(0, 4000)` char truncations across callers —
// guarantees that every writer enforces the same limits and that the device can
// size its fixed content buffers against a known upper bound.
//
// Rules:
// - Content is raw UTF-8 text; newlines are preserved verbatim.
// - HTML is NOT interpreted; it is escaped at render time, never at storage
//   time (storage keeps the exact bytes the author typed).
// - The binding length limit is characters (kept identical to the original
//   `notebook_notes_content_check` so no existing row becomes invalid), plus a
//   UTF-8 byte guardrail that is a strict superset of the character limit
//   (4000 chars x 4 bytes/char), so the byte cap can never reject content the
//   character cap already accepts while still bounding pathological input.

export const NOTE_CONTENT_FORMAT = 'plain_text_v1' as const;
export type NoteContentFormat = typeof NOTE_CONTENT_FORMAT;

export const NOTE_CONTENT_MAX_CHARS = 4000;
export const NOTE_CONTENT_MAX_BYTES = 16384; // 16 KiB == 4000 chars * 4 bytes
export const NOTE_CONTENT_MIN_CHARS = 1;
export const NOTE_TITLE_MAX_CHARS = 120;
export const NOTE_TITLE_MIN_CHARS = 1;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

export interface NoteContentValidationError {
  code: 'title_empty' | 'title_too_long' | 'content_empty' | 'content_too_long';
  message: string;
}

/**
 * Normalizes a note title for storage: trims surrounding whitespace. Newlines
 * are collapsed to spaces because a title is a single line.
 */
export function normalizeNoteTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes note content for storage: trims trailing whitespace on the whole
 * string but preserves interior newlines and leading indentation. This keeps
 * the byte-for-byte content stable across web/device without smuggling in
 * rich-text semantics.
 */
export function normalizeNoteContent(raw: string): string {
  // Normalize CRLF/CR to LF so the device and web share one newline fixture,
  // then strip only trailing whitespace/newlines.
  return raw.replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
}

/**
 * Validates a normalized title against the frozen format. Returns null when the
 * value is acceptable, otherwise a typed error describing the first failure.
 */
export function validateNoteTitle(
  title: string
): NoteContentValidationError | null {
  if (title.length < NOTE_TITLE_MIN_CHARS) {
    return { code: 'title_empty', message: 'Note title must not be empty' };
  }
  if (title.length > NOTE_TITLE_MAX_CHARS) {
    return {
      code: 'title_too_long',
      message: `Note title must be at most ${NOTE_TITLE_MAX_CHARS} characters`,
    };
  }
  return null;
}

/**
 * Validates normalized content against the frozen `plain_text_v1` format:
 * character count keeps parity with the database constraint and the UTF-8 byte
 * guardrail bounds device buffers.
 */
export function validateNoteContent(
  content: string
): NoteContentValidationError | null {
  if (content.length < NOTE_CONTENT_MIN_CHARS) {
    return { code: 'content_empty', message: 'Note content must not be empty' };
  }
  if (content.length > NOTE_CONTENT_MAX_CHARS) {
    return {
      code: 'content_too_long',
      message: `Note content must be at most ${NOTE_CONTENT_MAX_CHARS} characters`,
    };
  }
  if (utf8ByteLength(content) > NOTE_CONTENT_MAX_BYTES) {
    return {
      code: 'content_too_long',
      message: `Note content must be at most ${NOTE_CONTENT_MAX_BYTES} UTF-8 bytes`,
    };
  }
  return null;
}
