import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { agorStore } from '../store/agorStore';
import { pinnedMembers } from '../store/rowPins';
import { makeSession, withTestAuthority } from '../test/harness';
import { usePinnedOpenRows, usePinnedRows } from './usePinnedRows';

withTestAuthority('me:member:1', { dataAuthority: false });
beforeEach(() => {
  agorStore.getState().replaceMaps({
    sessionById: new Map(['s-a', 's-b', 's-c'].map((id) => [id, makeSession(id, `br-${id}`)])),
  });
});

const present = () => [...agorStore.getState().sessionById.keys()].sort();

describe('usePinnedRows', () => {
  it('pins the new ids before releasing the old ones, and releases on unmount', () => {
    const { rerender, unmount } = renderHook(({ ids }) => usePinnedRows({ sessions: ids }), {
      initialProps: { ids: ['s-a', 's-b'] },
    });
    rerender({ ids: ['s-b', 's-c'] });
    // s-a was released and no scope holds it; s-b never left.
    expect(present()).toEqual(['s-b', 's-c']);
    expect(pinnedMembers.sessions?.has('s-b')).toBe(true);
    unmount();
    expect(present()).toEqual([]);
  });
});

describe('usePinnedOpenRows', () => {
  it("pins the open session's branch with it", () => {
    const { unmount } = renderHook(() =>
      usePinnedOpenRows({ sessions: ['s-a'], branches: ['br-x'] })
    );
    expect(pinnedMembers.sessions?.has('s-a')).toBe(true);
    expect(pinnedMembers.branches?.has('br-s-a')).toBe(true);
    expect(pinnedMembers.branches?.has('br-x')).toBe(true);
    unmount();
    expect(pinnedMembers.branches?.has('br-s-a')).toBe(false);
  });
});
