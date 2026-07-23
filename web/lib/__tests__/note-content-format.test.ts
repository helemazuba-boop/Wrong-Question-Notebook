import { describe, expect, it } from 'vitest';
import {
  NOTE_CONTENT_MAX_BYTES,
  NOTE_CONTENT_MAX_CHARS,
  normalizeNoteContent,
  normalizeNoteTitle,
  utf8ByteLength,
  validateNoteContent,
  validateNoteTitle,
} from '@/lib/note-content-format';

describe('plain_text_v1 content format', () => {
  it('measures UTF-8 byte length, not JS char count', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    // Each CJK character is 3 UTF-8 bytes.
    expect(utf8ByteLength('错题本')).toBe(9);
    // Supplementary-plane emoji is 4 bytes but a single code point pair.
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('normalizes CRLF/CR to LF and trims only trailing whitespace', () => {
    expect(normalizeNoteContent('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeNoteContent('line1\nline2\n\n  ')).toBe('line1\nline2');
    // Interior newlines and leading indentation are preserved verbatim.
    expect(normalizeNoteContent('  keep\n    indent\n')).toBe(
      '  keep\n    indent'
    );
  });

  it('collapses whitespace in titles to a single line', () => {
    expect(normalizeNoteTitle('  hello   world \n')).toBe('hello world');
  });

  it('rejects empty content and empty titles', () => {
    expect(validateNoteContent('')?.code).toBe('content_empty');
    expect(validateNoteTitle('')?.code).toBe('title_empty');
  });

  it('accepts content at the character limit', () => {
    expect(validateNoteContent('a'.repeat(NOTE_CONTENT_MAX_CHARS))).toBeNull();
  });

  it('rejects content beyond the character limit', () => {
    expect(
      validateNoteContent('a'.repeat(NOTE_CONTENT_MAX_CHARS + 1))?.code
    ).toBe('content_too_long');
  });

  it('keeps the byte guardrail a strict superset of the char limit', () => {
    // 4000 CJK chars = 12000 bytes, under the 16384 guardrail: the char limit
    // is always the binding constraint, so no char-valid note is byte-rejected.
    const cjk = '错'.repeat(NOTE_CONTENT_MAX_CHARS);
    expect(utf8ByteLength(cjk)).toBeLessThanOrEqual(NOTE_CONTENT_MAX_BYTES);
    expect(validateNoteContent(cjk)).toBeNull();
  });

  it('rejects titles longer than 120 characters', () => {
    expect(validateNoteTitle('a'.repeat(121))?.code).toBe('title_too_long');
  });
});
