import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasNavigationProvider,
  useConsumePendingRecenter,
  useRecenterMap,
  useRegisterBoardView,
  useRegisterRecenter,
} from './CanvasNavigationContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <CanvasNavigationProvider>{children}</CanvasNavigationProvider>
);

const setup = (switched: boolean) => {
  const recenter = vi.fn(() => true);
  const showBoard = vi.fn(() => switched);
  const { result } = renderHook(
    () => {
      useRegisterRecenter(recenter);
      useRegisterBoardView(showBoard);
      return { recenterMap: useRecenterMap(), consumePending: useConsumePendingRecenter() };
    },
    { wrapper }
  );
  return { recenter, showBoard, ...result.current };
};

describe('useRecenterMap and the Board tab', () => {
  it('shows the Board tab for a deliberate recenter and stashes the target for the canvas', () => {
    const { recenter, showBoard, recenterMap, consumePending } = setup(true);
    expect(recenterMap('branch-1', { boardId: 'board-1' })).toBe(true);
    expect(showBoard).toHaveBeenCalledWith('board-1');
    expect(recenter).not.toHaveBeenCalled();
    expect(consumePending()).toEqual({
      nodeId: 'branch-1',
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
