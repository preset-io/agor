import { useMediaQuery } from './useMediaQuery';

/** Whether the primary pointer can hover; false on phones and touch tablets. */
export function useCanHover(): boolean {
  return useMediaQuery('(hover: hover)');
}
