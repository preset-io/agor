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

it('syncs only the current user/key across tabs and handles storage clearing', () => {
  const { result, rerender } = renderHook(({ userId }) => useUserLocalStorage(userId, 'test', 0), {
    initialProps: { userId: 'a' },
  });
  localStorage.setItem('agor:user:a:test', '1');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'agor:user:a:test' })));
  expect(result.current[0]).toBe(1);
  rerender({ userId: 'b' });
  localStorage.setItem('agor:user:a:test', '2');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'agor:user:a:test' })));
  expect(result.current[0]).toBe(0);
  act(() => result.current[1](3));
  localStorage.clear();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(result.current[0]).toBe(0);
});

it('syncs other readers of the same key in this tab, without echoing to the writer', () => {
  const initial = { x: 1 };
  const writer = renderHook(() => useUserLocalStorage('a', 'opened', initial));
  const reader = renderHook(() => useUserLocalStorage('a', 'opened', initial));
  const other = renderHook(() => useUserLocalStorage('a', 'other', 0));
  const otherBefore = other.result.current[0];

  const next = { x: 2 };
  act(() => writer.result.current[1](next));

  expect(reader.result.current[0]).toEqual({ x: 2 });
  // The writer keeps the value it wrote rather than re-parsing a copy.
  expect(writer.result.current[0]).toBe(next);
  expect(other.result.current[0]).toBe(otherBefore);
});
