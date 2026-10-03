import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store is module-level and caches its first read, so each test gets a
 * freshly imported copy.
 */
async function loadStore() {
  vi.resetModules();
  return import('../print-placement');
}

function stubWindow(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    addEventListener: (_type: string, listener: () => void) =>
      void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      void listeners.delete(listener),
  });
  return { stored, listeners };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('print placement store', () => {
  it('defaults to answers-at-the-end when nothing is stored', async () => {
    stubWindow();
    const store = await loadStore();
    expect(store.getPrintPlacement()).toBe('end');
  });

  it('returns the stored placement', async () => {
    stubWindow({ 'wqn.print.placement': 'below' });
    const store = await loadStore();
    expect(store.getPrintPlacement()).toBe('below');
  });

  it('ignores a stored value that is not a placement', async () => {
    stubWindow({ 'wqn.print.placement': 'sideways' });
    const store = await loadStore();
    expect(store.getPrintPlacement()).toBe('end');
  });

  it('survives storage that throws on read', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('site data blocked');
        },
        setItem: () => {},
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const store = await loadStore();
    expect(store.getPrintPlacement()).toBe('end');
  });

  it('always reports the default to the server, so hydration matches', async () => {
    stubWindow({ 'wqn.print.placement': 'none' });
    const store = await loadStore();
    expect(store.getServerPrintPlacement()).toBe('end');
  });

  it('persists a new placement and tells its subscribers', async () => {
    const { stored, listeners } = stubWindow();
    const store = await loadStore();

    let notifications = 0;
    const unsubscribe = store.subscribePrintPlacement(() => {
      notifications += 1;
    });

    store.setPrintPlacement('below');

    expect(stored.get('wqn.print.placement')).toBe('below');
    expect(store.getPrintPlacement()).toBe('below');
    expect(notifications).toBe(1);
    expect(listeners.size).toBe(1);

    unsubscribe();
    expect(listeners.size).toBe(0);

    store.setPrintPlacement('none');
    expect(notifications).toBe(1);
  });

  it('survives storage that throws on write', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('site data blocked');
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const store = await loadStore();
    expect(() => store.setPrintPlacement('none')).not.toThrow();
    // The in-memory value is what the sheet renders from.
    expect(store.getPrintPlacement()).toBe('none');
  });
});
