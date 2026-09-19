import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

const NARROW = '(max-width: 767px)';
const WIDE = '(max-width: 1023px)';

function stubMatchMedia(initial: Record<string, boolean>) {
  const matches = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  const listenersFor = (query: string) => {
    if (!listeners.has(query)) listeners.set(query, new Set());
    return listeners.get(query) as Set<() => void>;
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return matches.get(query) ?? false;
        },
        addEventListener: (_: string, listener: () => void) => listenersFor(query).add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          listenersFor(query).delete(listener),
      }) as unknown as MediaQueryList
  );
  return {
    set(query: string, next: boolean) {
      matches.set(query, next);
      for (const listener of listenersFor(query)) listener();
    },
    listenerCount: (query: string) => listenersFor(query).size,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('useMediaQuery', () => {
  it('is correct on the very first render', () => {
    stubMatchMedia({ [NARROW]: true });
    const renders: boolean[] = [];
    renderHook(() => renders.push(useMediaQuery(NARROW)));
    expect(renders[0]).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith(NARROW);
  });

  it('re-subscribes to the new query when it changes', () => {
    const media = stubMatchMedia({ [NARROW]: false, [WIDE]: false });
    const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: NARROW },
    });
    expect(media.listenerCount(NARROW)).toBe(1);
    rerender({ query: WIDE });
    expect(media.listenerCount(NARROW)).toBe(0);
    expect(media.listenerCount(WIDE)).toBe(1);
    act(() => media.set(WIDE, true));
    expect(result.current).toBe(true);
  });

  it('follows changes and unsubscribes on unmount', () => {
    const media = stubMatchMedia({ [NARROW]: false });
    const { result, unmount } = renderHook(() => useMediaQuery(NARROW));
    expect(result.current).toBe(false);
    act(() => media.set(NARROW, true));
    expect(result.current).toBe(true);
    unmount();
    expect(media.listenerCount(NARROW)).toBe(0);
  });
});
