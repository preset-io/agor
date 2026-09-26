import { useMediaQuery } from './useMediaQuery';

/** Whether the user has requested reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
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
