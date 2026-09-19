import useDelayStateEsm from '@rc-component/util/es/hooks/useDelayState';
import useDelayStateCjs from '@rc-component/util/lib/hooks/useDelayState';
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the runtime patch, not a test-only cleanup: AntD Form uses this hook,
// whose outstanding callbacks otherwise dispatch after its owner is unmounted.
describe.each([
  ['ESM', useDelayStateEsm],
  ['CJS', useDelayStateCjs],
] as const)('AntD delayed state lifecycle (%s)', (_format, useDelayState) => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const delay of [{ ms: 100 }, { frame: 1 }] as const) {
    it(`cancels ${'ms' in delay ? 'timer' : 'frame'} updates on unmount`, () => {
      const { result, unmount } = renderHook(() => useDelayState(0), {
        wrapper: StrictMode,
      });
      const pendingUpdate = vi.fn(() => 1);
      act(() => result.current[1](pendingUpdate, delay));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.runAllTimers());
      expect(pendingUpdate).not.toHaveBeenCalled();
    });
  }

  it('keeps latest-update-wins and immediate updates while mounted', () => {
    const { result, unmount } = renderHook(() => useDelayState(0));
    act(() => {
      result.current[1](1, { ms: 100 });
      result.current[1](2, { ms: 100 });
      vi.advanceTimersByTime(100);
    });
    expect(result.current[0]).toBe(2);
    act(() => {
      result.current[1](3, { ms: 100 });
      result.current[1](4, true);
      vi.runAllTimers();
    });
    expect(result.current[0]).toBe(4);
    unmount();
  });
});
