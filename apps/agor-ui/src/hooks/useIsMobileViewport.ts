import { useSyncExternalStore } from 'react';
import { isMobileViewport, MOBILE_SHELL_MEDIA_QUERY } from '../utils/deviceDetection';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const query = window.matchMedia(MOBILE_SHELL_MEDIA_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Reactive companion to `isMobileViewport()`: `true` while the viewport is
 * narrow enough to use the mobile shell, re-rendering on resize/orientation
 * change. Use in render paths; use `isMobileViewport()` in imperative code.
 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false);
}
