import type { AgorClient, Board, Branch, Repo, Session, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, Input, theme } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { getRouterBasename } from '../../utils/uiRoutes';
import { BoardWorkspace } from './BoardWorkspace';
import { boardViewPreferenceKey } from './useBoardViewPreferences';

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
    const renderView = (conversationOpen = !compact, compactView = compact) => (
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
                  conversationOpen={conversationOpen}
                  compact={compactView}
                />
              </div>
            </ConnectionProvider>
          </App>
        </ConfigProvider>
      </MemoryRouter>
    );
    const view = render(renderView());
    expect(screen.getByRole('tab', { name: 'Sessions', exact: true })).toBeVisible();
    expect(screen.getByText('Atlas', { exact: true })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Plan the next release')).toBeVisible());
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    await page.screenshot({
      path: `../../../.vitest/attachments/agor-sessions-${mode}-${window.innerWidth}.png`,
    });
    let treeWidth = 0;
    let boardWidth = 0;
    if (!compact) {
      await userEvent.fill(screen.getByLabelText('Conversation draft'), 'Keep this draft');
      const handle = screen.getByRole('separator', { name: 'Resize tree and detail' });
      const navigator = screen.getByLabelText('Board navigator');
      const before = navigator.clientWidth;
      act(() => handle.focus());
      await userEvent.keyboard('{ArrowRight}');
      await waitFor(() => expect(navigator.clientWidth).toBeGreaterThan(before));
      expect(handle).toHaveFocus();
      expect(getComputedStyle(handle).outlineStyle).not.toBe('none');
      treeWidth = navigator.clientWidth;
    } else {
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    }
    await userEvent.click(screen.getByText('Board', { exact: true }));
    expect(screen.getByText('Shared canvas')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(screen.getByLabelText('Board navigator')).not.toBeVisible();
    if (!compact) {
      const handle = screen.getByRole('separator', { name: 'Resize board and detail' });
      const detail = screen.getByRole('region', { name: 'Board detail' });
      const before = detail.clientWidth;
      await userEvent.dragAndDrop(handle, detail, {
        targetPosition: { x: 60, y: 80 },
        force: true,
      });
      await waitFor(() => expect(detail.clientWidth).toBeLessThan(before));
      boardWidth = detail.clientWidth;
      expect(screen.getByLabelText('Conversation draft')).toHaveValue('Keep this draft');
    }
    await userEvent.click(screen.getByText('Tree', { exact: true }));
    if (!compact) {
      expect(screen.getByLabelText('Conversation draft')).toHaveValue('Keep this draft');
      await waitFor(() =>
        expect(screen.getByLabelText('Board navigator').clientWidth).toBe(treeWidth)
      );
    }
    await userEvent.click(screen.getByRole('tab', { name: 'Content', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: /Release plan/ }));
    expect(await screen.findByRole('heading', { name: 'Release plan' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    await page.screenshot({
      path: `../../../.vitest/attachments/agor-board-tree-${mode}-${window.innerWidth}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close content' }));
    if (!compact) {
      // Remount models a reload: both view sizes survive independently.
      view.unmount();
      const restored = render(renderView());
      await waitFor(() =>
        expect(screen.getByLabelText('Board navigator').clientWidth).toBe(treeWidth)
      );
      await userEvent.click(screen.getByText('Board', { exact: true }));
      await waitFor(() =>
        expect(screen.getByRole('region', { name: 'Board detail' }).clientWidth).toBe(boardWidth)
      );
      // Opening/closing the inspector must not replace the saved split with 100%.
      restored.rerender(renderView(false));
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
      expect(screen.getByText('Shared canvas')).toBeVisible();
      restored.rerender(renderView(false, true));
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
      restored.rerender(renderView());
      await waitFor(() =>
        expect(screen.getByRole('region', { name: 'Board detail' }).clientWidth).toBe(boardWidth)
      );
      const key = boardViewPreferenceKey(getRouterBasename(), user.user_id, board.board_id);
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      expect(saved.treeNavigatorSize).toBeGreaterThan(32);
      expect(saved.boardCanvasSize).toBeGreaterThan(55);
    }
  }
);
