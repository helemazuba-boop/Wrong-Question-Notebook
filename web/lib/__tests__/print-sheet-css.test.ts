import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression guard for the screen-side answer leak.
 *
 * The old print feature marked its worksheet markup `print-*` and put every
 * rule — including the `display: none` that was supposed to keep it off the
 * screen — inside a single `@media print` block. On screen those elements
 * therefore had no styling at all, so the answer key and the solution text
 * rendered as ordinary page content: a student reading a problem saw every
 * answer at the bottom of the page without clicking anything.
 *
 * These tests pin the property that made the fix structural rather than a
 * matter of remembering to add a rule: the sheet's own `display: none` lives
 * OUTSIDE print media, and the app's global stylesheet carries no print block
 * that could hide app chrome by accident.
 */

const WEB_ROOT = join(__dirname, '..', '..');
const SHEET_CSS = join(
  WEB_ROOT,
  'app/[locale]/(app)/subjects/[id]/problems/[problemId]/review/print-sheet.css'
);
const GLOBALS_CSS = join(WEB_ROOT, 'app/globals.css');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Strips comments so a commented-out rule cannot satisfy a check. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Byte offsets of every top-level `@media print { … }` block. */
function printBlockRanges(css: string): Array<[number, number]> {
  const source = withoutComments(css);
  const ranges: Array<[number, number]> = [];
  const opener = /@media\s+print\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const start = match.index;
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      index += 1;
    }
    ranges.push([start, index]);
  }
  return ranges;
}

function isInsidePrintMedia(css: string, offset: number): boolean {
  return printBlockRanges(css).some(
    ([start, end]) => offset >= start && offset < end
  );
}

/** Offset of the declaration of `selector { … }`, or -1. */
function ruleOffset(css: string, selector: string): number {
  const source = withoutComments(css);
  const pattern = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`,
    'm'
  );
  const match = pattern.exec(source);
  return match ? match.index + match[1].length : -1;
}

/** Every rule head in the file, at-rules excluded. */
function selectorsOf(css: string): string[] {
  const source = withoutComments(css);
  const selectors: string[] = [];
  const pattern = /([^{}]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const head = match[1].trim().replace(/\s+/g, ' ');
    if (head.length === 0 || head.startsWith('@')) continue;
    selectors.push(head);
  }
  return selectors;
}

const sheetCss = read(SHEET_CSS);

describe('print-sheet.css', () => {
  it('hides the sheet on screen from a rule outside @media print', () => {
    const offset = ruleOffset(sheetCss, '.print-sheet');
    expect(offset).toBeGreaterThan(-1);
    expect(isInsidePrintMedia(sheetCss, offset)).toBe(false);
  });

  it('flips the sheet back on for print media', () => {
    expect(sheetCss).toMatch(
      /body\s*>\s*\.print-sheet\s*\{[^}]*display:\s*block/
    );
  });

  it('hides every other direct child of body while printing', () => {
    const offset = ruleOffset(sheetCss, 'body > *');
    expect(offset).toBeGreaterThan(-1);
    expect(isInsidePrintMedia(sheetCss, offset)).toBe(true);
    expect(sheetCss).toMatch(
      /body\s*>\s*\*\s*\{[^}]*display:\s*none\s*!important/
    );
  });

  it('scopes every rule under the sheet, so nothing reaches the live page', () => {
    // The two page-level selectors are the ones that hide the app shell and
    // show the sheet instead; everything else must be a descendant of it.
    const pageLevel = new Set(['body > *', 'body > .print-sheet']);
    const selectors = selectorsOf(sheetCss);
    expect(selectors.length).toBeGreaterThan(10);

    for (const selector of selectors) {
      for (const part of selector.split(',')) {
        const head = part.trim();
        const scoped = head.startsWith('.print-sheet') || pageLevel.has(head);
        if (!scoped) {
          throw new Error(`unscoped print rule: ${head}`);
        }
      }
    }
  });

  it('forces light ink so a dark theme cannot print white-on-white', () => {
    expect(sheetCss).toMatch(
      /\.print-sheet[^{]*\{[^}]*color:\s*#000\s*!important/
    );
    expect(sheetCss).toMatch(
      /\.print-sheet[^{]*\{[^}]*background:\s*#fff\s*!important/
    );
  });

  it('sets the paper size and margins, which the Android adapter omits', () => {
    expect(sheetCss).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(sheetCss).toMatch(/@page\s*\{[^}]*margin:/);
  });

  it('keeps the answer key on its own page', () => {
    expect(sheetCss).toMatch(/\.print-sheet-key\s*\{[^}]*break-before:\s*page/);
  });
});

describe('globals.css', () => {
  it('carries no print media block of its own', () => {
    // A second print block is how the old one hid app chrome by naming
    // Tailwind utility classes, which silently stops matching the day the
    // markup changes.
    expect(printBlockRanges(read(GLOBALS_CSS))).toEqual([]);
  });

  it('no longer references the retired print-* class names', () => {
    const source = read(GLOBALS_CSS);
    for (const dead of [
      'print-header',
      'print-answer-appendix',
      'print-answer-inline',
      'print-solution-appendix',
      'print-reveal',
      'data-print-hide',
    ]) {
      expect(source).not.toContain(dead);
    }
  });
});
