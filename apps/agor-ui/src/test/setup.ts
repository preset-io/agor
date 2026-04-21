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
