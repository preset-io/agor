import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const query = window.matchMedia(QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

/** Whether the user has requested reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * AntD Drawer/Modal props that disable the slide/fade animations when the user
 * prefers reduced motion. Spread onto the surface: `{...reducedMotionSurface(r)}`.
 */
export function reducedMotionSurface(reduced: boolean): {
  transitionName?: string;
  maskTransitionName?: string;
} {
  return reduced ? { transitionName: '', maskTransitionName: '' } : {};
}
