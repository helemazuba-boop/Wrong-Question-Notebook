/**
 * Where printed answers go, remembered across sessions.
 *
 * The worksheet is committed to the document before it is printed, so a bare
 * Ctrl+P — which never opens the print dialog — has to print the same
 * worksheet the dialog would have produced. That only works if the placement
 * still stands after a reload, which means reading it from an external store
 * rather than holding it in component state.
 *
 * It is an external store rather than state hydrated by an effect because the
 * value has to survive the server render: `getServerSnapshot` gives the default
 * on the server, and React re-renders with the real value on the client
 * without a hydration mismatch and without a cascading extra render.
 */

import type { PrintAnswerPlacement } from './print-sheet-model';

const STORAGE_KEY = 'wqn.print.placement';
const DEFAULT_PLACEMENT: PrintAnswerPlacement = 'end';

const listeners = new Set<() => void>();
let cached: PrintAnswerPlacement | undefined;

function isPlacement(value: unknown): value is PrintAnswerPlacement {
  return value === 'end' || value === 'below' || value === 'none';
}

function readPlacement(): PrintAnswerPlacement {
  if (cached === undefined) {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      cached = isPlacement(stored) ? stored : DEFAULT_PLACEMENT;
    } catch {
      // Site data blocked: the default still prints a sane worksheet.
      cached = DEFAULT_PLACEMENT;
    }
  }
  return cached;
}

export function subscribePrintPlacement(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the preference should move this tab's sheet too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function getPrintPlacement(): PrintAnswerPlacement {
  return readPlacement();
}

export function getServerPrintPlacement(): PrintAnswerPlacement {
  return DEFAULT_PLACEMENT;
}

export function setPrintPlacement(placement: PrintAnswerPlacement): void {
  cached = placement;
  try {
    window.localStorage.setItem(STORAGE_KEY, placement);
  } catch {
    // Nothing to write to; the in-memory value is what the sheet renders from.
  }
  for (const listener of listeners) listener();
}
