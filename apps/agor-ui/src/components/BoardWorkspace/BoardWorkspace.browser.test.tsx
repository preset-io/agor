import type { AgorClient, Board, Branch, Repo, Session, User } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, Input, theme } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardWorkspace } from './BoardWorkspace';

const board = {
  board_id: 'board-tree-test',
  name: 'Product',
  primary_teammate_id: 'atlas',
  objects: {
    note: {
      type: 'markdown',
      x: 100,
      y: 100,
      width: 500,
      content: '# Release plan\nShared notes for the team.',
    },
  },
} as unknown as Board;
const user = { user_id: 'viewer', name: 'Viewer', role: 'member' } as User;
const primary = {
  branch_id: 'atlas',
  name: 'atlas',
  board_id: board.board_id,
  repo_id: 'repo',
  filesystem_status: 'ready',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Atlas' } },
} as unknown as Branch;
const branch = {
  ...primary,
  branch_id: 'feature',
  name: 'Improve navigation',
  custom_context: {},
} as Branch;
const session = {
  session_id: 'session',
  branch_id: primary.branch_id,
  title: 'Plan the next release',
  status: 'idle',
  agentic_tool: 'codex',
  created_by: user.user_id,
  archived: false,
  created_at: '2026-10-01T00:00:00Z',
  last_updated: '2026-10-22T00:00:00Z',
  genealogy: { children: [] },
} as unknown as Session;
const repo = { repo_id: primary.repo_id, name: 'Project', slug: 'team/project' } as Repo;
const client = {
  service: () => ({ find: async () => ({ can: 'session', capabilities: ['board.view'] }) }),
} as unknown as AgorClient;
beforeEach(() => {
  localStorage.clear();
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    branchById: new Map([
      [primary.branch_id, primary],
      [branch.branch_id, branch],
    ]),
    sessionById: new Map([[session.session_id, session]]),
    sessionsByBranch: new Map([[primary.branch_id, [session]]]),
    repoById: new Map([[repo.repo_id, repo]]),
    userById: new Map([[user.user_id, user]]),
  });
});
afterEach(cleanup);
function Draft() {
  const [text, setText] = useState('');
  return (
    <Input.TextArea
      aria-label="Conversation draft"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}
it.each(['light', 'dark'] as const)(
  'shows alternative navigation without overflow and preserves draft (%s)',
  async (mode) => {
    const compact = window.innerWidth < 700;
    render(
      <MemoryRouter>
        <ConfigProvider
          theme={{ algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
        >
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
              <div style={{ height: '100vh', display: 'flex' }}>
                <BoardWorkspace
                  board={board}
                  branches={[branch, primary]}
                  actions={{
                    client,
                    board,
                    boardReady: true,
                    currentUserId: user.user_id,
                    primaryTeammateBranch: primary,
                    primaryTeammateRepo: repo,
                    primaryTeammateInaccessible: false,
                    onSessionClick: vi.fn(),
                    onCreateSession: vi.fn(),
                  }}
                  canvas={<div>Shared canvas</div>}
                  conversation={<Draft />}
                  conversationOpen={!compact}
                  compact={compact}
                />
              </div>
            </ConnectionProvider>
          </App>
        </ConfigProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('tab', { name: 'Sessions', exact: true })).toBeVisible();
    expect(screen.getByText('Atlas', { exact: true })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Plan the next release')).toBeVisible());
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    await page.screenshot({
      path: `../../../.vitest/attachments/agor-sessions-${mode}-${window.innerWidth}.png`,
    });
    if (!compact)
      await userEvent.fill(screen.getByLabelText('Conversation draft'), 'Keep this draft');
    await userEvent.click(screen.getByText('Board', { exact: true }));
    expect(screen.getByText('Shared canvas')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(screen.getByLabelText('Board navigator')).not.toBeVisible();
    await userEvent.click(screen.getByText('Tree', { exact: true }));
    if (!compact)
      expect(screen.getByLabelText('Conversation draft')).toHaveValue('Keep this draft');
    await userEvent.click(screen.getByRole('tab', { name: 'Content', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: /Release plan/ }));
    expect(await screen.findByRole('heading', { name: 'Release plan' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    await page.screenshot({
      path: `../../../.vitest/attachments/agor-board-tree-${mode}-${window.innerWidth}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close content' }));
  }
);
