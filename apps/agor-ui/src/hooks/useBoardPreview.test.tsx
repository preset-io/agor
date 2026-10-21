import type { BranchID } from '@agor-live/client';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useBoardPreview } from './useBoardPreview';

const branchA = { kind: 'branch', id: 'branch-a' as BranchID } as const;
const branchB = { kind: 'branch', id: 'branch-b' as BranchID } as const;

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useBoardPreview', () => {
  it('opens, swaps in place and closes', () => {
    const { result } = renderHook(() => useBoardPreview('board-1'));
    expect(result.current.preview).toBeNull();

    act(() => result.current.openPreview(branchA));
    expect(result.current.preview?.target).toEqual(branchA);
    const firstOpen = result.current.preview?.openId;

    act(() => result.current.setPreviewFullScreen(true));
    act(() => result.current.openPreview(branchB));
    // Another item swaps the content and keeps the pane as it was.
    expect(result.current.preview?.target).toEqual(branchB);
    expect(result.current.preview?.fullScreen).toBe(true);
    expect(result.current.preview?.openId).not.toBe(firstOpen);

    act(() => result.current.closePreview());
    expect(result.current.preview).toBeNull();
  });

  it('starts split and toggles full screen', () => {
    const { result } = renderHook(() => useBoardPreview('board-1'));
    act(() => result.current.openPreview(branchA));
    expect(result.current.preview?.fullScreen).toBe(false);
    act(() => result.current.setPreviewFullScreen(true));
    expect(result.current.preview?.fullScreen).toBe(true);
    act(() => result.current.setPreviewFullScreen(false));
    expect(result.current.preview?.fullScreen).toBe(false);
  });

  it('drops the preview when the board changes', () => {
    const { result, rerender } = renderHook(({ boardId }) => useBoardPreview(boardId), {
      initialProps: { boardId: 'board-1' },
    });
    act(() => result.current.openPreview(branchA));
    rerender({ boardId: 'board-2' });
    expect(result.current.preview).toBeNull();
    rerender({ boardId: 'board-1' });
    expect(result.current.preview).toBeNull();
  });

  it('returns focus to the trigger it was given on close', () => {
    const trigger = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(trigger, other);
    const { result } = renderHook(() => useBoardPreview('board-1'));

    other.focus();
    act(() => result.current.openPreview(branchA, { returnFocus: trigger }));
    act(() => result.current.closePreview());
    expect(document.activeElement).toBe(trigger);
  });

  it('defaults to the element focused at open time', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const { result } = renderHook(() => useBoardPreview('board-1'));

    trigger.focus();
    act(() => result.current.openPreview(branchA));
    trigger.blur();
    act(() => result.current.closePreview());
    expect(document.activeElement).toBe(trigger);
  });
});
