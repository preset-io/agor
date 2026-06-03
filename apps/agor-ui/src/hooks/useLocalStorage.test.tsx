import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStorage } from './useLocalStorage';

const KEY = 'agor:test-local-storage';

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('syncs updates to other mounted hooks in the same tab', () => {
    const first = renderHook(() => useLocalStorage<string>(KEY, 'recent'));
    const second = renderHook(() => useLocalStorage<string>(KEY, 'recent'));

    act(() => first.result.current[1]('oldest'));

    expect(first.result.current[0]).toBe('oldest');
    expect(second.result.current[0]).toBe('oldest');
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toBe('oldest');
  });

  it('falls back to the initial value for malformed stored JSON', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.localStorage.setItem(KEY, '{not-json');

    const { result } = renderHook(() => useLocalStorage<string>(KEY, 'recent'));

    expect(result.current[0]).toBe('recent');
    expect(consoleError).toHaveBeenCalled();
  });
});
