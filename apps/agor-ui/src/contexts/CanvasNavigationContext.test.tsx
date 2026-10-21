import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasNavigationProvider,
  useRecenterMap,
  useRegisterBoardView,
  useRegisterRecenter,
} from './CanvasNavigationContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <CanvasNavigationProvider>{children}</CanvasNavigationProvider>
);

afterEach(() => vi.useRealTimers());

const setup = (switched: boolean) => {
  const recenter = vi.fn(() => true);
  const showBoard = vi.fn(() => switched);
  const { result } = renderHook(
    () => {
      useRegisterRecenter(recenter);
      useRegisterBoardView(showBoard);
      return useRecenterMap();
    },
    { wrapper }
  );
  return { recenter, showBoard, recenterMap: result.current };
};

describe('useRecenterMap and the Board tab', () => {
  it('shows the Board tab for a deliberate recenter, then recenters once laid out', () => {
    vi.useFakeTimers();
    const { recenter, showBoard, recenterMap } = setup(true);
    act(() => {
      recenterMap('branch-1', { boardId: 'board-1' });
    });
    expect(showBoard).toHaveBeenCalledWith('board-1');
    expect(recenter).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(recenter).toHaveBeenCalledWith('branch-1', {
      sessionId: undefined,
      ensureVisible: undefined,
    });
  });

  it('recenters at once when Board is already shown', () => {
    const { recenter, recenterMap } = setup(false);
    recenterMap('branch-1', { boardId: 'board-1' });
    expect(recenter).toHaveBeenCalledTimes(1);
  });

  it('never changes tabs for a selection (ensure-visible) recenter', () => {
    const { showBoard, recenterMap } = setup(true);
    recenterMap('branch-1', { boardId: 'board-1', sessionId: 's1', ensureVisible: true });
    expect(showBoard).not.toHaveBeenCalled();
  });
});
