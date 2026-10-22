import type { AgorClient, Board, Branch, BranchID, Repo, Session, User } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { resetAccessCacheForTests } from '../../utils/accessCache';
import { BoardPreviewPane } from './BoardPreviewPane';

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../ToolIcon', () => ({ ToolIcon: () => null }));

const connected = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const BRANCH_ID = 'branch-1' as BranchID;
const repoWithEnv = {
  repo_id: 'repo-1',
  slug: 'acme/app',
  environment_config: { up_command: 'up', down_command: 'down', logs_command: 'logs' },
} as unknown as Repo;
const repoWithoutEnv = { repo_id: 'repo-1', slug: 'acme/app' } as unknown as Repo;
const teammate = {
  branch_id: 'teammate-1',
  board_id: 'board-1',
  name: 'kelly',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Kelly' } },
} as unknown as Branch;
const board = { board_id: 'board-1', primary_teammate_id: 'teammate-1' } as unknown as Board;
const baseBranch = {
  branch_id: BRANCH_ID,
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'northwind-qbr',
} as unknown as Branch;
const session = {
  session_id: 'session-1',
  branch_id: BRANCH_ID,
  title: 'QBR prep',
  agentic_tool: 'claude-code',
  status: 'idle',
  created_at: '2026-10-21T10:00:00.000Z',
  last_updated: '2026-10-21T10:00:00.000Z',
} as unknown as Session;

function seed(branch: Partial<Branch>, repo: Repo = repoWithEnv, onBoard: Board = board) {
  const full = { ...baseBranch, ...branch } as Branch;
  agorStore.setState({
    branchById: new Map([
      [full.branch_id, full],
      [teammate.branch_id, teammate],
    ]),
    repoById: new Map([[repo.repo_id, repo]]),
    boardById: new Map([[onBoard.board_id, onBoard]]),
    sessionsByBranch: new Map([[full.branch_id, [session]]]),
  });
}

const envButton = (label: string) => screen.getByText(label).closest('button') as HTMLElement;

const actions = {
  onSessionClick: vi.fn(),
  onStartEnvironment: vi.fn(),
  onStopEnvironment: vi.fn(),
  onViewLogs: vi.fn(),
};

const admin = { user_id: 'user-1', role: 'admin' } as User;
const member = { user_id: 'user-2', role: 'member' } as User;
/** A client answering `effective-access` with `access`, or never when it is absent. */
const clientWith = (access?: { can: string }) => {
  const find = vi.fn(() => (access ? Promise.resolve(access) : new Promise(() => {})));
  return { service: () => ({ find }) } as unknown as AgorClient;
};

const boardView: BoardViewContextValue = {
  view: 'chat',
  showOnBoard: vi.fn(),
  previewTarget: { kind: 'branch', id: BRANCH_ID },
  openPreview: vi.fn(),
  closePreview: vi.fn(),
  openConversation: vi.fn(),
};

function renderPane(props: Partial<React.ComponentProps<typeof BoardPreviewPane>> = {}) {
  const handlers = { onShowOnBoard: vi.fn(), onClose: vi.fn(), onToggleFullScreen: vi.fn() };
  render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider value={actions}>
        <BoardViewContext.Provider value={boardView}>
          <AntApp>
            <BoardPreviewPane
              target={{ kind: 'branch', id: BRANCH_ID }}
              client={clientWith()}
              user={admin}
              fullScreen={false}
              {...handlers}
              {...props}
            />
          </AntApp>
        </BoardViewContext.Provider>
      </AppActionsProvider>
    </ConnectionProvider>
  );
  return handlers;
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  vi.mocked(boardView.openConversation).mockReset();
  resetAccessCacheForTests();
});
afterEach(cleanup);

describe('BoardPreviewPane header', () => {
  it('is a labelled region with the title, type and status, and its actions', () => {
    seed({ pull_request_url: 'https://github.com/acme/app/pull/14' });
    const { onShowOnBoard, onClose, onToggleFullScreen } = renderPane();

    expect(screen.getByRole('region', { name: 'Preview: northwind-qbr' })).toBeInTheDocument();
    expect(screen.getByText('Branch · Ready to review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open full screen/ }));
    expect(onToggleFullScreen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Show on board/ }));
    expect(onShowOnBoard).toHaveBeenCalledWith(BRANCH_ID);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from inside the preview', () => {
    seed({});
    const { onClose } = renderPane();
    fireEvent.keyDown(screen.getByRole('button', { name: /Show on board/ }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers Exit full screen in full screen, and no toggle when the window is too narrow', () => {
    seed({});
    renderPane({ fullScreen: true });
    expect(screen.getByRole('button', { name: /Exit full screen/ })).toBeInTheDocument();
    cleanup();
    renderPane({ fullScreen: true, onToggleFullScreen: undefined });
    expect(screen.queryByRole('button', { name: /full screen/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeInTheDocument();
  });

  it('swaps the content when the target changes', () => {
    seed({});
    const other = { ...baseBranch, branch_id: 'branch-2', name: 'renewal-tracker' } as Branch;
    agorStore.setState({
      branchById: new Map([...agorStore.getState().branchById, [other.branch_id, other]]),
    });
    renderPane();
    cleanup();
    renderPane({ target: { kind: 'branch', id: other.branch_id } });
    expect(screen.getByRole('region', { name: 'Preview: renewal-tracker' })).toBeInTheDocument();
  });
});

describe('Branch details', () => {
  it('leads with what the teammate did, then the app and pull request', () => {
    seed({
      notes: 'Built the QBR dashboard.',
      app_url: 'https://northwind.example.com',
      pull_request_url: 'https://github.com/acme/app/pull/14',
    });
    renderPane();
    expect(screen.getByRole('heading', { name: 'What Kelly did' })).toBeInTheDocument();
    expect(screen.getByText('Built the QBR dashboard.')).toBeInTheDocument();
    const app = screen.getByRole('link', { name: /Open app/ });
    expect(app).toHaveAttribute('href', 'https://northwind.example.com');
    expect(app).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: /View pull request #14/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/14'
    );
  });

  it('falls back to the environment link for the app and to a plain pull request label', () => {
    seed({
      pull_request_url: 'https://gitlab.example.com/acme/app/merge_requests/9',
      environment_instance: {
        status: 'running',
        access_urls: [{ name: 'App', url: 'http://localhost:5173' }],
      } as Branch['environment_instance'],
    });
    renderPane();
    expect(screen.getByRole('link', { name: /Open app/ })).toHaveAttribute(
      'href',
      'http://localhost:5173'
    );
    expect(screen.getByRole('link', { name: /^pull-request View pull request$/ })).toBeTruthy();
  });

  it('says so when there is no app or pull request, and leaves out empty notes', () => {
    seed({});
    renderPane();
    expect(screen.getByText('No app or pull request for this branch.')).toBeInTheDocument();
    expect(screen.queryByText(/did$/)).toBeNull();
  });

  it('reads "Notes" when the board has no primary teammate', () => {
    seed({ notes: 'Built the QBR dashboard.' }, repoWithEnv, {
      ...board,
      primary_teammate_id: undefined,
    } as Board);
    renderPane();
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /did$/ })).toBeNull();
  });

  it('prefers the link the environment reports over the static app link, as the pills do', () => {
    seed({
      app_url: 'https://northwind.example.com',
      environment_instance: {
        status: 'running',
        access_urls: [{ name: 'App', url: 'http://localhost:5173' }],
      } as Branch['environment_instance'],
    });
    renderPane();
    expect(screen.getByRole('link', { name: /Open app/ })).toHaveAttribute(
      'href',
      'http://localhost:5173'
    );
  });

  it('lists the conversations about it, opening one through the preview rule', () => {
    seed({});
    renderPane();
    expect(screen.getByRole('heading', { name: 'Conversations about it' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /QBR prep/ }));
    expect(boardView.openConversation).toHaveBeenCalledWith('session-1');
    expect(actions.onSessionClick).not.toHaveBeenCalled();
  });

  it('marks the conversation already on screen as current', () => {
    seed({});
    renderPane({ currentSessionId: 'session-1' });
    expect(screen.getByRole('button', { name: /QBR prep/ })).toHaveAttribute(
      'aria-current',
      'true'
    );
    cleanup();
    renderPane({ currentSessionId: 'session-9' });
    expect(screen.getByRole('button', { name: /QBR prep/ })).not.toHaveAttribute('aria-current');
  });

  it('folds the environment away, with Start, Stop and Logs on the strip handlers', () => {
    seed({
      logs_command: 'docker compose logs',
      environment_instance: { status: 'stopped' } as Branch['environment_instance'],
    });
    renderPane();
    const header = screen.getByRole('button', { name: /Environment/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Start')).toBeNull();

    fireEvent.click(header);
    fireEvent.click(envButton('Start'));
    expect(actions.onStartEnvironment).toHaveBeenCalledWith(BRANCH_ID);
    // Stopped: nothing to stop.
    expect(envButton('Stop')).toBeDisabled();
    fireEvent.click(envButton('Logs'));
    expect(actions.onViewLogs).toHaveBeenCalledWith(BRANCH_ID);
  });

  it('stops a running environment', () => {
    seed({ environment_instance: { status: 'running' } as Branch['environment_instance'] });
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    expect(envButton('Start')).toBeDisabled();
    fireEvent.click(envButton('Stop'));
    expect(actions.onStopEnvironment).toHaveBeenCalledWith(BRANCH_ID);
  });

  it('offers Logs for a rendered logs command alone, and not without one', () => {
    const repoUpDown = {
      ...repoWithEnv,
      environment_config: { up_command: 'up', down_command: 'down' },
    } as unknown as Repo;
    seed(
      {
        logs_command: 'docker compose logs',
        environment_instance: { status: 'running' } as Branch['environment_instance'],
      },
      repoUpDown
    );
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    expect(envButton('Logs')).toBeEnabled();
    cleanup();
    seed({ environment_instance: { status: 'running' } as Branch['environment_instance'] });
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    expect(screen.queryByText('Logs')).toBeNull();
  });

  it('disables Start, Stop and Logs for a viewer, and says why', async () => {
    seed({
      logs_command: 'docker compose logs',
      environment_instance: { status: 'running' } as Branch['environment_instance'],
    });
    renderPane({ user: member, client: clientWith({ can: 'view' }) });
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    expect(
      await screen.findByText('You need full control of this branch to control its environment.')
    ).toBeInTheDocument();
    for (const label of ['Start', 'Stop', 'Logs']) expect(envButton(label)).toBeDisabled();
  });

  it('keeps the controls disabled while access is loading', () => {
    seed({
      logs_command: 'docker compose logs',
      environment_instance: { status: 'stopped' } as Branch['environment_instance'],
    });
    renderPane({ user: member, client: clientWith() });
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    for (const label of ['Start', 'Logs']) expect(envButton(label)).toBeDisabled();
    expect(screen.queryByText(/You need full control/)).toBeNull();
  });

  it('enables the controls for full control', async () => {
    seed({ environment_instance: { status: 'stopped' } as Branch['environment_instance'] });
    renderPane({ user: member, client: clientWith({ can: 'all' }) });
    fireEvent.click(screen.getByRole('button', { name: /Environment/ }));
    await vi.waitFor(() => expect(envButton('Start')).toBeEnabled());
  });

  it('reads "Not set up" with no buttons when the repo has no environment', () => {
    seed({}, repoWithoutEnv);
    renderPane();
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Environment/ })).toBeNull();
    for (const label of ['Start', 'Stop', 'Logs']) expect(screen.queryByText(label)).toBeNull();
  });
});
