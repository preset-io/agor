import type { AgorClient, Board, User } from '@agor-live/client';
import { cleanup, render, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { SettingsModal } from './SettingsModal';

const ADMIN = { user_id: 'admin', email: 'alex@example.test', name: 'Alex', role: 'admin' } as User;
const service = vi.fn(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  find: vi.fn(async () => []),
}));
const client = { io: { on: vi.fn(), off: vi.fn() }, service } as unknown as AgorClient;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
// Room for a classic vertical scrollbar, which sits inside the viewport width.
const SCROLLBAR = 16;

afterEach(async () => {
  cleanup();
  agorStore.getState().reset();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it('keeps the board delete confirmation clear of the right edge at 1280px', async () => {
  await page.viewport(1280, 800);
  agorStore.setState({
    userById: new Map([[ADMIN.user_id, ADMIN]]),
    boardById: new Map([['board-0', { board_id: 'board-0', name: 'Engineering' } as Board]]),
  });
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter>
        <AntdApp>
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
            <SettingsModal
              open
              activeTab="boards"
              currentUser={ADMIN}
              client={client}
              onClose={vi.fn()}
            />
          </ConnectionProvider>
        </AntdApp>
      </MemoryRouter>
    </ConfigProvider>
  );
  await waitFor(() => expect(document.querySelector('.anticon-delete')).toBeTruthy());
  await userEvent.click(
    document.querySelector('.anticon-delete')?.closest('button') as HTMLElement
  );
  await waitFor(() => {
    const popover = document.querySelector('.ant-popover') as HTMLElement | null;
    expect(popover).toBeTruthy();
    const rect = (popover as HTMLElement).getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth - SCROLLBAR);
  });
});
