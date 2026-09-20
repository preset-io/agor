import type { Board, BoardEntityObject, Branch, Session } from '@agor-live/client';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ConfigProvider, Layout, theme } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { MobileBoardPage } from './MobileBoardPage';

vi.mock('../MarkdownRenderer/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
afterEach(cleanup);
const teammate = {
  branch_id: 'assistant',
  name: 'assistant-branch',
  board_id: 'board',
  filesystem_status: 'ready',
  custom_context: {
    teammate: {
      kind: 'teammate',
      displayName: 'Ada — your board assistant with a very long display name',
      emoji: '🦊',
    },
  },
} as Branch;
const ordinary = { branch_id: 'work', name: 'Ordinary branch', board_id: 'board' } as Branch;
const sessions = Array.from(
  { length: 5 },
  (_, i) =>
    ({
      session_id: `session-${i}`,
      branch_id: 'assistant',
      title: `Assistant task ${i}`,
      last_updated: `2026-09-0${5 - i}`,
      status: 'idle',
    }) as Session
);
const board = { board_id: 'board', name: 'Delivery', primary_teammate_id: 'assistant' } as Board;
const onNewSession = vi.fn();

function tree(
  currentBoard: Board,
  branches = new Map([
    ['assistant', teammate],
    ['work', ordinary],
  ])
) {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <MemoryRouter initialEntries={['/m/board/board']}>
        <Routes>
          <Route
            path="/m/board/:boardId"
            element={
              <Layout style={{ height: '100dvh', maxWidth: 600, margin: 'auto' }}>
                <MobileBoardPage
                  boardById={new Map([['board', currentBoard]])}
                  branchById={branches}
                  repoById={new Map()}
                  sessionsByBranch={new Map([['assistant', sessions]])}
                  boardObjectsByBoardId={
                    new Map([
                      [
                        'board',
                        [
                          { branch_id: 'work', position: { x: 0, y: 0 } },
                          { branch_id: 'assistant', position: { x: 0, y: 1 } },
                        ] as BoardEntityObject[],
                      ],
                    ])
                  }
                  cardById={new Map()}
                  artifactById={new Map()}
                  onOpenBranch={vi.fn()}
                  onNewSession={onNewSession}
                  onGiveFirstTask={vi.fn()}
                />
              </Layout>
            }
          />
          <Route path="/m/session/:sessionId" element={<div>Opened session</div>} />
        </Routes>
      </MemoryRouter>
    </ConfigProvider>
  );
}

it('leads with the assigned teammate, keeps ordinary browsing, and opens all teammate sessions', async () => {
  render(tree(board));
  const region = screen.getByRole('region', {
    name: `Primary teammate: ${teammate.custom_context?.teammate?.displayName}`,
  });
  expect(screen.getAllByText('Primary teammate')).toHaveLength(1);
  expect(screen.getAllByText('Delivery')).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'Delivery', level: 4 })).not.toBeInTheDocument();
  expect(screen.getByText('Ordinary branch')).toBeInTheDocument();
  expect(region.getBoundingClientRect().top).toBeLessThan(
    screen.getByText('Ordinary branch').getBoundingClientRect().top
  );
  expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
  expect(region.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  const row = within(region).getByRole('button', { name: 'Open Assistant task 0' });
  expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(within(region).queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
  await page.screenshot({ path: `./.vitest/mobile-teammate-${window.innerWidth}.png` });
  await userEvent.click(within(region).getByRole('button', { name: /New session/ }));
  expect(onNewSession).toHaveBeenCalledWith('assistant');
  await userEvent.click(within(region).getByTitle('Next Page'));
  await userEvent.click(
    await within(region).findByRole('button', { name: 'Open Assistant task 4' })
  );
  expect(await screen.findByText('Opened session')).toBeInTheDocument();
});

it('tracks assignment/access changes without a second mobile state or empty assignment UI', () => {
  const { rerender } = render(tree(board));
  expect(screen.getByRole('region')).toBeInTheDocument();
  // A late branch for the old assignment cannot become the new board primary.
  rerender(tree({ ...board, primary_teammate_id: 'different' } as Board));
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  rerender(tree(board, new Map([['work', ordinary]])));
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(screen.queryByText('Primary teammate')).not.toBeInTheDocument();
  rerender(tree({ ...board, primary_teammate_id: undefined }));
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(screen.queryByText(/assign|associate|choose.*teammate/i)).not.toBeInTheDocument();
});
