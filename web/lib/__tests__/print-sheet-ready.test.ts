import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForSheetReady } from '../print-sheet-ready';

/**
 * `waitForSheetReady` is the ordering guarantee the old print flow lacked. What
 * matters about it is not that it waits, but that it always finishes: a print
 * call that hangs is worse than one that prints stale content, so the wait is
 * bounded and every failure path still resolves.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubDom(options: {
  fontsReady?: Promise<void> | 'rejects' | 'missing';
  animationFrame?: 'immediate' | 'never';
}) {
  vi.stubGlobal('document', {
    fonts:
      options.fontsReady === 'missing'
        ? undefined
        : {
            ready:
              options.fontsReady === 'rejects'
                ? Promise.reject(new Error('fonts unavailable'))
                : (options.fontsReady ?? Promise.resolve()),
          },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    if (options.animationFrame === 'never') return 0;
    callback(0);
    return 0;
  });
}

describe('waitForSheetReady', () => {
  it('resolves once fonts and a frame have settled', async () => {
    stubDom({ animationFrame: 'immediate' });
    await expect(waitForSheetReady()).resolves.toBeUndefined();
  });

  it('yields to a macrotask queued before it, which is what lets the sheet render its math', async () => {
    stubDom({ animationFrame: 'immediate' });
    let mathRendered = false;

    // This is the shape of RichTextDisplay's own setTimeout(0) math pass.
    setTimeout(() => {
      mathRendered = true;
    }, 0);

    await waitForSheetReady();
    expect(mathRendered).toBe(true);
  });

  it('resolves when the font API is missing entirely', async () => {
    stubDom({ fontsReady: 'missing', animationFrame: 'immediate' });
    await expect(waitForSheetReady()).resolves.toBeUndefined();
  });

  it('resolves when the font promise rejects', async () => {
    stubDom({ fontsReady: 'rejects', animationFrame: 'immediate' });
    await expect(waitForSheetReady()).resolves.toBeUndefined();
  });

  it('does not hang when neither fonts nor a frame ever arrive', async () => {
    // A hidden tab stops firing animation frames. Printing must still happen.
    stubDom({
      fontsReady: new Promise<void>(() => {}),
      animationFrame: 'never',
    });
    await expect(waitForSheetReady()).resolves.toBeUndefined();
  });
});
