import { useMediaQuery } from './useMediaQuery';

/** Whether the primary pointer can hover; false on phones and touch tablets. */
export function useCanHover(): boolean {
  return useMediaQuery('(hover: hover)');
}

/** The primary pointer cannot hover: phones and touch tablets, where a tap emulates hover. */
export const TOUCH_INPUT_QUERY = '(hover: none)';

/**
 * Whether the primary input is touch. Unlike `!useCanHover()`, this is false
 * where matchMedia matches nothing (jsdom), so desktop behavior is the default.
 */
export function useIsTouchInput(): boolean {
  return useMediaQuery(TOUCH_INPUT_QUERY);
}
