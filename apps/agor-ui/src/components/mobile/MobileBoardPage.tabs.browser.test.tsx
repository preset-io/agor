import type { AgorClient, Board, User } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { MobileBoardPage } from './MobileBoardPage';

vi.mock('../SessionCanvas/SessionCanvas', () => ({ default: () => <div>Shared canvas</div> }));
const board = {
  board_id: 'board-1',
  name: 'Delivery with a long board name',
  objects: {},
} as Board;
const user = { user_id: 'owner', role: 'admin' } as User;
const client = { service: () => ({ find: async () => [] }) } as unknown as AgorClient;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  await page.viewport(originalViewport.width, originalViewport.height);
});
it.each([320, 390, 430])(
  'keeps the board selector and view switch together at %ipx',
  async (width) => {
    await page.viewport(width, 760);
    localStorage.clear();
    agorStore.setState({
      ...EMPTY_MAPS,
      boardById: new Map([[board.board_id, board]]),
      userById: new Map([[user.user_id, user]]),
    });
    const onCreateBranch = vi.fn();
    render(
      <App>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 1,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <MemoryRouter initialEntries={['/m/board/board-1']}>
            <Routes>
              <Route
                path="/m/board/:boardId"
                element={
                  <div style={{ height: 760, display: 'flex', flexDirection: 'column' }}>
                    <MobileBoardPage
                      settingsHydrated
                      client={client}
                      currentUser={user}
                      boardById={agorStore.getState().boardById}
                      branchById={new Map()}
                      onOpenBranch={vi.fn()}
                      onNewSession={vi.fn()}
                      onCreateBranch={onCreateBranch}
                      onForkSession={vi.fn(async () => {})}
                      onSpawnSession={vi.fn(async () => {})}
                      onSendComment={vi.fn()}
                    />
                  </div>
                }
              />
            </Routes>
          </MemoryRouter>
        </ConnectionProvider>
      </App>
    );
    const switcher = screen
      .getByRole('radio', { name: 'Tree', exact: true })
      .closest('.ant-segmented')!;
    const boardName = document.querySelector('[data-current-board-name]')!;
    const boardRect = boardName.getBoundingClientRect();
    const viewRect = switcher.getBoundingClientRect();
    expect(boardRect.right).toBeLessThanOrEqual(viewRect.left);
    expect(boardRect.top).toBeGreaterThanOrEqual(viewRect.top);
    expect(boardRect.bottom).toBeLessThanOrEqual(viewRect.bottom);
    expect(screen.getAllByRole('radio', { name: 'Tree', exact: true })).toHaveLength(1);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Sessions',
      'Content',
      'Comments',
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New branch' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'New branch' }));
    expect(onCreateBranch).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByText('Board', { exact: true }));
    expect(await screen.findByText('Shared canvas')).toBeVisible();
    expect(screen.getByLabelText('Board navigator')).not.toBeVisible();
    await userEvent.click(screen.getByText('Tree', { exact: true }));
    expect(screen.getByLabelText('Board navigator')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest/attachments/mobile-board-navbar-${width}.png`,
    });
  }
);
