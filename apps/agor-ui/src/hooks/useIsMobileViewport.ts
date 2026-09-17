import { useSyncExternalStore } from 'react';
import { isMobileViewport, MOBILE_SHELL_MEDIA_QUERY } from '../utils/deviceDetection';
import { subscribeToMediaQuery } from './useMediaQuery';

const subscribe = (onChange: () => void) =>
  subscribeToMediaQuery(MOBILE_SHELL_MEDIA_QUERY, onChange);

/**
 * Reactive companion to `isMobileViewport()`: `true` while the viewport is
 * narrow enough to use the mobile shell, re-rendering on resize/orientation
 * change. Use in render paths; use `isMobileViewport()` in imperative code.
 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false);
}
