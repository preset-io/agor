import '@testing-library/jest-dom';

// jsdom does not implement matchMedia, but antd's responsive helpers
// (Grid, Modal, etc.) subscribe to it during layout effects. Stub it out
// so component tests can render antd-based UI without throwing.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Node 25 ships a `globalThis.localStorage` global that lacks the standard
// Storage methods (no `getItem` / `setItem` / etc.). When the test runner
// is launched with NODE_OPTIONS=--localstorage-file=..., this broken stub
// takes precedence over jsdom's real Storage, and any component that calls
// `localStorage.getItem(...)` throws "is not a function". Replace it with
// an in-memory Storage shim before tests start.
if (
  typeof globalThis !== 'undefined' &&
  (!globalThis.localStorage ||
    typeof (globalThis.localStorage as { setItem?: unknown }).setItem !== 'function')
) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    writable: true,
    configurable: true,
  });
}
