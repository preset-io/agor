import type { Board } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useChatOpensSelectedTab } from './useBoardViewShell';

const BOARD = { board_id: '01a15e00-0000-7000-8000-000000000001', slug: 'team' } as Board;

const renderAt = (path: string, board: Board = BOARD) => {
  const onOpen = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {[
          '/b/:boardParam/',
          '/s/:sessionShortId/',
          '/w/:branchShortId/',
          '/a/:artifactShortId/',
        ].map((route) => (
          <Route key={route} path={route} element={children} />
        ))}
      </Routes>
    </MemoryRouter>
  );
  renderHook(
    () =>
      useChatOpensSelectedTab({
        active: true,
        board,
        tabIds: ['s1', 's2'],
        selectedTabId: 's2',
        onOpen,
      }),
    { wrapper }
  );
  return onOpen;
};

describe('useChatOpensSelectedTab', () => {
  it('opens the selected tab on the board’s own link', () => {
    expect(renderAt('/b/team/')).toHaveBeenCalledWith('s2');
    expect(renderAt('/b/01a15e00/')).toHaveBeenCalledWith('s2');
  });

  it('leaves branch, artifact and session links alone', () => {
    expect(renderAt('/w/01a15e11/')).not.toHaveBeenCalled();
    expect(renderAt('/a/01a15e22/')).not.toHaveBeenCalled();
    expect(renderAt('/s/01a15e33/')).not.toHaveBeenCalled();
  });

  it('waits until the board link names the board on screen', () => {
    expect(renderAt('/b/other-board/')).not.toHaveBeenCalled();
  });
});
