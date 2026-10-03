/**
 * Waits until a freshly committed print sheet is ready to be captured.
 *
 * Why this exists: the sheet renders problem text through `RichTextDisplay`,
 * which fills in KaTeX in a `useEffect` + `setTimeout(0)` rather than during
 * render, and a print snapshot taken in the same tick as the commit would
 * capture the math *empty* — the serialised TipTap element has no text content
 * to fall back to, so the formula would vanish from the worksheet instead of
 * printing as raw source. Waiting for one animation frame plus one macrotask
 * is what lets that effect run.
 *
 * This replaces the old approach, which was two copies of an un-awaited
 * `import('katex').then(...)` fired from a `beforeprint` listener. That could
 * never work: `window.print()` blocks the main thread in Chrome, so the
 * callback could not run until after the snapshot it was meant to fix, and the
 * Android bridge dispatched `beforeprint` without waiting either. Awaiting
 * *before* calling print makes the ordering a fact rather than a hope.
 *
 * Always resolves. Printing must never hang on a page that is slow, hidden, or
 * missing an API, so the wait is bounded and degrades to "print now".
 */

/** Upper bound on the wait; past this we print with whatever is on screen. */
const READY_TIMEOUT_MS = 1500;

export function waitForSheetReady(): Promise<void> {
  const ready = (async () => {
    // Web fonts gate glyph coverage: a font that has not loaded prints as a
    // fallback face, and KaTeX's math font is the one that matters.
    try {
      await document.fonts.ready;
    } catch {
      // No FontFaceSet (or a browser that throws on it): nothing to wait for.
    }
    // One frame so layout settles, then one macrotask so the sheet's own
    // setTimeout(0) math pass has run.
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  })();

  return Promise.race([
    ready,
    new Promise<void>(resolve => setTimeout(resolve, READY_TIMEOUT_MS)),
  ]);
}
