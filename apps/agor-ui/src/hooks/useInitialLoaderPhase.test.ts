import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADER_FADE_MS, useInitialLoaderPhase } from './useInitialLoaderPhase';

const base = {
  connecting: false,
  loading: false,
  dataError: null,
  mustChangePassword: false,
  initialLoadComplete: false,
};

describe('useInitialLoaderPhase', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts fading (so the workspace mounts) as soon as the load completes', () => {
    const { result, rerender } = renderHook((props) => useInitialLoaderPhase(props), {
      initialProps: { ...base, loading: true },
    });
    expect(result.current).toBe('loading');

    rerender({ ...base, initialLoadComplete: true });
    expect(result.current).toBe('fading');

    act(() => vi.advanceTimersByTime(LOADER_FADE_MS - 1));
    expect(result.current).toBe('fading');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('done');
  });

  it('skips the fade on a data error', () => {
    const { result } = renderHook(() => useInitialLoaderPhase({ ...base, dataError: 'boom' }));
    expect(result.current).toBe('done');
  });

  it('holds while the pre-fetch window reports loading:false', () => {
    const { result } = renderHook(() => useInitialLoaderPhase(base));
    expect(result.current).toBe('loading');
  });
});
