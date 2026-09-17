import { useSyncExternalStore } from 'react';
import { isMobileViewport } from '../utils/deviceDetection';

// Subscribes to `resize` because the snapshot reads `innerWidth`; a media query can disagree with it at fractional widths.
function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/**
 * Reactive companion to `isMobileViewport()`: `true` while the viewport is
 * narrow enough to use the mobile shell, re-rendering on resize/orientation
 * change. Use in render paths; use `isMobileViewport()` in imperative code.
 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false);
}
