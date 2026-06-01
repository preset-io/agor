import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUserLocalStorage } from './useUserLocalStorage';

describe('useUserLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists values under a per-user key', () => {
    const { result } = renderHook(() => useUserLocalStorage('user-a', 'panel:left:size', 24));

    act(() => result.current[1](33));

    expect(localStorage.getItem('agor:user:user-a:panel:left:size')).toBe('33');
  });

  it('loads a different value when the user changes', () => {
    localStorage.setItem('agor:user:user-a:panel:right:size', '42');
    localStorage.setItem('agor:user:user-b:panel:right:size', '55');

    const { result, rerender } = renderHook(
      ({ userId }) => useUserLocalStorage(userId, 'panel:right:size', 50),
      { initialProps: { userId: 'user-a' as string | undefined } }
    );

    expect(result.current[0]).toBe(42);

    rerender({ userId: 'user-b' });

    expect(result.current[0]).toBe(55);
  });

  it('does not write a shared value before a user id is available', () => {
    const { result } = renderHook(() => useUserLocalStorage(undefined, 'panel:left:size', 24));

    act(() => result.current[1](30));

    expect(localStorage.length).toBe(0);
  });
});
