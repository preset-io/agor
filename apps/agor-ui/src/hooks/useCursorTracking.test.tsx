import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCursorTracking } from './useCursorTracking';

describe('useCursorTracking', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces mousemove bursts and sends only volatile cursor samples', () => {
    vi.useFakeTimers();
    const volatileEmit = vi.fn();
    const normalEmit = vi.fn();
    const client = {
      io: {
        emit: normalEmit,
        volatile: { emit: volatileEmit },
      },
    };
    const reactFlowInstance = {
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    };
    const { unmount } = renderHook(() =>
      useCursorTracking({
        client: client as never,
        boardId: 'board-1' as never,
        reactFlowInstance: reactFlowInstance as never,
      })
    );

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 2 }));
      for (let index = 2; index <= 20; index++) {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: index, clientY: index + 1 }));
      }
    });

    // The first sample is immediate; the rest of the burst is one trailing,
    // latest-position sample at the 100ms cadence (10/s steady state).
    expect(volatileEmit).toHaveBeenCalledTimes(1);
    expect(volatileEmit).toHaveBeenLastCalledWith('cursor-move', {
      boardId: 'board-1',
      x: 1,
      y: 2,
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(volatileEmit).toHaveBeenCalledTimes(2);
    expect(volatileEmit).toHaveBeenLastCalledWith('cursor-move', {
      boardId: 'board-1',
      x: 20,
      y: 21,
    });
    expect(normalEmit).not.toHaveBeenCalled();

    unmount();
    expect(volatileEmit).toHaveBeenLastCalledWith('cursor-leave', { boardId: 'board-1' });
  });
});
