import { useCallback, useSyncExternalStore } from 'react';

/** Subscribes `onChange` to a media query; returns the unsubscribe function. */
export function subscribeToMediaQuery(query: string, onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const list = window.matchMedia(query);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** Whether a media query matches, correct on the first render (unlike AntD's `Grid.useBreakpoint`). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToMediaQuery(query, onChange),
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}
