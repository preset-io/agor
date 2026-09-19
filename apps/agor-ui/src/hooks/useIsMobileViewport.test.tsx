import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_SHELL_MAX_WIDTH } from '../utils/deviceDetection';
import { useIsMobileViewport } from './useIsMobileViewport';

function resizeTo(width: number) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => vi.restoreAllMocks());

describe('useIsMobileViewport', () => {
  it('is correct on the first render and follows resizes across the shell breakpoint', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(MOBILE_SHELL_MAX_WIDTH - 1);
    const renders: boolean[] = [];
    const { result } = renderHook(() => {
      const isMobile = useIsMobileViewport();
      renders.push(isMobile);
      return isMobile;
    });
    expect(renders[0]).toBe(true);
    act(() => resizeTo(MOBILE_SHELL_MAX_WIDTH));
    expect(result.current).toBe(false);
    act(() => resizeTo(390));
    expect(result.current).toBe(true);
  });

  it('stops listening on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useIsMobileViewport());
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
