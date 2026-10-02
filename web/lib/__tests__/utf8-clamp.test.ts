import { describe, expect, it } from 'vitest';

import { clampCodePoints, clampUtf8Bytes } from '@/lib/utf8-clamp';

/** True when a string contains an unpaired surrogate (what `.slice` produces). */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('clampUtf8Bytes', () => {
  it('returns short strings untouched', () => {
    expect(clampUtf8Bytes('hello', 1024)).toBe('hello');
    expect(clampUtf8Bytes('', 1024)).toBe('');
  });

  it('bounds a CJK answer by bytes, not UTF-16 units', () => {
    // 8192 CJK characters are 24576 bytes: the old `.slice(0, 8192)` sent all
    // of them, 3x over the device's `text_event_bytes` buffer.
    const value = '汉'.repeat(8192);
    const clamped = clampUtf8Bytes(value, 8 * 1024);
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    // 8192 / 3 = 2730 whole characters.
    expect(clamped).toHaveLength(2730);
    expect(value.startsWith(clamped)).toBe(true);
  });

  it('never splits a code point when the budget ends mid-character', () => {
    // Three 4-byte emoji = 12 bytes; a 10-byte budget fits two whole ones.
    const clamped = clampUtf8Bytes('😀😀😀', 10);
    expect(clamped).toBe('😀😀');
    expect(Buffer.byteLength(clamped, 'utf8')).toBe(8);
    expect(hasLoneSurrogate(clamped)).toBe(false);
  });

  it('drops a character rather than overrunning the budget by one byte', () => {
    // 'ab😀' is 2 + 4 = 6 bytes; a 5-byte budget cannot include the emoji.
    expect(clampUtf8Bytes('ab😀', 5)).toBe('ab');
  });

  it('keeps an exactly-fitting string whole', () => {
    const value = '汉'.repeat(4); // 12 bytes
    expect(clampUtf8Bytes(value, 12)).toBe(value);
    expect(clampUtf8Bytes(value, 11)).toHaveLength(3);
  });
});

describe('clampCodePoints', () => {
  it('returns short strings untouched', () => {
    expect(clampCodePoints('hello', 160)).toBe('hello');
  });

  it('counts an astral character once and keeps it whole', () => {
    // `.slice(0, 2)` on '😀😀😀' takes exactly one emoji by luck; `.slice(0, 3)`
    // splits the second one. Code-point clamping is stable at every bound.
    expect(clampCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(clampCodePoints('😀😀😀', 3)).toBe('😀😀😀');
    expect(hasLoneSurrogate(clampCodePoints('😀😀😀', 2))).toBe(false);
  });

  it('clamps CJK text to the schema maxLength', () => {
    expect(clampCodePoints('汉'.repeat(200), 160)).toHaveLength(160);
  });

  it('drops an astral character instead of splitting it at the bound', () => {
    const value = 'abcd😀'; // 6 UTF-16 units, 5 code points
    expect(clampCodePoints(value, 4)).toBe('abcd');
    expect(clampCodePoints(value, 5)).toBe(value);
    expect(hasLoneSurrogate(clampCodePoints(value, 4))).toBe(false);
  });
});
