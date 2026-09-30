import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LEGACY_KEY = 'agor:recentBoardIds';

// The legacy key is taken once per page load, so each test gets a fresh module.
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
});
