/**
 * Clamping helpers for values that cross the device contract.
 *
 * The contract's manifest bounds are expressed in UTF-8 *bytes*
 * (`max_text_event_bytes`, `max_delta_event_bytes`, ...) because the firmware
 * copies them into fixed byte buffers. The schema's `maxLength` counts code
 * points. Neither equals `String.prototype.length`, which counts UTF-16 code
 * units: one CJK character is 3 UTF-8 bytes but 1 code point and 1 unit, while
 * an emoji is 4 bytes / 1 code point / 2 units.
 *
 * So a `.slice(0, 8192)` over a Chinese answer can emit ~24 KB of UTF-8 -- 3x
 * over the firmware buffer -- and can also split a surrogate pair, producing a
 * lone surrogate that `JSON.stringify` turns into `\ud83d`, which the device's
 * parser then rejects or renders as mojibake. These helpers never do either.
 */

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * Walks code points so the cut always lands on a character boundary; the
 * result may therefore be shorter than `maxBytes` by up to 3 bytes.
 */
export function clampUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const cost = Buffer.byteLength(char, 'utf8');
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    out += char;
  }
  return out;
}

/**
 * Truncate to at most `max` code points without splitting a surrogate pair.
 *
 * `for...of` iterates code points, so an astral character counts once and is
 * kept or dropped whole -- unlike `.slice`, which counts its two UTF-16 units
 * separately and will happily cut between them. The `value.length` fast path
 * is safe because UTF-16 units >= code points.
 */
export function clampCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  let count = 0;
  let out = '';
  for (const char of value) {
    if (count >= max) break;
    count += 1;
    out += char;
  }
  return out;
}
