import type { AgorClient, Board, Branch } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../index.css';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { BoardTeammatePanel } from './BoardTeammatePanel';

checkBrowserSanity();

const board = { board_id: 'board-1', name: 'Board' } as Board;
const branches = Array.from(
  { length: 40 },
  (_, index) =>
    ({
      branch_id: `branch-${index}`,
      board_id: board.board_id,
      repo_id: 'repo-1',
      name: `Branch ${String(index).padStart(2, '0')}`,
      last_used: new Date(Date.UTC(2026, 8, 1) - index * 1000).toISOString(),
    }) as Branch
);
const service = {
  findAll: vi.fn().mockResolvedValue(branches),
  on: vi.fn(),
  removeListener: vi.fn(),
};
const client = { service: vi.fn().mockReturnValue(service) } as unknown as AgorClient;

beforeEach(() => agorStore.setState({ ...EMPTY_MAPS }));
afterEach(cleanup);

it('scrolls older branches independently of the teammate drawer tabs and count footer', async () => {
  const onCollapse = vi.fn();
  render(
    <App>
      <div data-testid="drawer" style={{ height: '100vh', width: 320 }}>
        <BoardTeammatePanel
          board={board}
          activeTab="all-branches"
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          onCollapse={onCollapse}
          client={client}
        />
      </div>
    </App>
  );

  const lastRow = await screen.findByText('Branch 39');
  const firstRow = screen.getByText('Branch 00');
  const list = screen.getByRole('region', { name: 'Board branches' });
  const footer = screen.getByText('40 branches');
  const tab = screen.getByRole('tab', { name: 'Branches' });
  const drawer = screen.getByTestId('drawer');

  expect(tab).toBeVisible();
  expect(firstRow.getBoundingClientRect().top).toBeGreaterThan(tab.getBoundingClientRect().bottom);
  expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    drawer.getBoundingClientRect().bottom
  );
  expect(lastRow.getBoundingClientRect().top).toBeGreaterThan(footer.getBoundingClientRect().top);

  list.focus();
  await userEvent.keyboard('{PageDown}');
  await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
  await act(async () => {
    list.scrollTop = list.scrollHeight;
  });
  expect(list.scrollTop).toBeGreaterThan(0);
  expect(firstRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    list.getBoundingClientRect().top
  );
  expect(lastRow.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    list.getBoundingClientRect().top
  );
  expect(lastRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    footer.getBoundingClientRect().top
  );
  expect(footer).toBeVisible();
  expect(tab).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
  expect(onCollapse).toHaveBeenCalledOnce();
});
