import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LEGACY_KEY = 'agor:recentBoardIds';

// The legacy key is migrated at most once per page load, so each test gets a fresh module.
async function loadHook() {
  vi.resetModules();
  return (await import('./useRecentBoards')).useRecentBoards;
}

describe('useRecentBoards', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('moves the shared pre-per-user history to the first signed-in user without their own', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['b1', 'b2']));
    const useRecentBoards = await loadHook();
    const { result } = renderHook(() => useRecentBoards([], '', 'user-1'));
    await waitFor(() => expect(result.current.recentBoardIds).toEqual(['b1', 'b2']));
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("keeps a user's own history and still retires the shared key", async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['old']));
    window.localStorage.setItem('agor:user:user-1:recentBoardIds', JSON.stringify(['mine']));
    const useRecentBoards = await loadHook();
    const { result } = renderHook(() => useRecentBoards([], '', 'user-1'));
    await waitFor(() => expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull());
    expect(result.current.recentBoardIds).toEqual(['mine']);
  });

  it('keeps the moved history when a child instance mounts first and the parent tracks a visit', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['b1', 'b2']));
    const useRecentBoards = await loadHook();
    let parent: ReturnType<typeof useRecentBoards> | undefined;
    function Child() {
      useRecentBoards([], '', 'user-1');
      return null;
    }
    function Parent() {
      parent = useRecentBoards([], '', 'user-1');
      return <Child />;
    }
    render(<Parent />);
    expect(parent?.recentBoardIds).toEqual(['b1', 'b2']);
    act(() => parent?.trackBoardVisit('b9'));
    expect(
      JSON.parse(window.localStorage.getItem('agor:user:user-1:recentBoardIds') ?? '[]')
    ).toEqual(['b9', 'b1', 'b2']);
  });

  it('records visits without a subscription, and none before there is a user', async () => {
    vi.resetModules();
    const { useTrackBoardVisit, useRecentBoards } = await import('./useRecentBoards');
    const anonymous = renderHook(() => useTrackBoardVisit(undefined));
    act(() => anonymous.result.current('b1'));
    expect(Object.keys(window.localStorage)).toEqual([]);

    const reader = renderHook(() => useRecentBoards([], '', 'user-1'));
    const tracker = renderHook(() => useTrackBoardVisit('user-1'));
    act(() => tracker.result.current('b1'));
    act(() => tracker.result.current('b2'));
    act(() => tracker.result.current('b1'));
    expect(reader.result.current.recentBoardIds).toEqual(['b1', 'b2']);
  });

  it('keeps the shared key when the per-user write fails', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['b1']));
    const useRecentBoards = await loadHook();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderHook(() => useRecentBoards([], '', 'user-1'));
    } finally {
      setItem.mockRestore();
      error.mockRestore();
    }
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(['b1']));
    const nextLoad = await loadHook();
    renderHook(() => nextLoad([], '', 'user-1'));
    expect(window.localStorage.getItem('agor:user:user-1:recentBoardIds')).toBe(
      JSON.stringify(['b1'])
    );
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
