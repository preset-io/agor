import type { Branch, Repo, Session, User } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { MOBILE_SHELL_MAX_WIDTH } from '../../utils/deviceDetection';
import SessionPanel from './SessionPanel';

// Keep the real header and responsive shell; the transcript/composer are unrelated.
vi.mock('./SessionPanelContent', () => ({ SessionPanelContent: () => null }));
vi.mock('./SessionFooter', () => ({ SessionFooter: () => null }));
vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));

checkBrowserSanity();
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  agorStore.setState({ userById: new Map(), repoById: new Map() });
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(['light', 'dark'])(
  'bounds creator attribution and preserves header actions (%s)',
  async (mode) => {
    if (originalViewport.width > 320) await page.viewport(1440, 900);
    const creator = {
      user_id: 'creator',
      name: 'Averylongunbrokencreatordisplaynamethatmustnotcoverheaderactions'.repeat(2),
    } as User;
    const session = {
      session_id: 'session-1',
      agentic_tool: 'codex',
      title: 'Review panel headers',
      status: 'awaiting_permission',
      created_by: creator.user_id,
    } as unknown as Session;
    const onUpdateSession = vi.fn();
    const onClose = vi.fn();
    agorStore.setState({ userById: new Map([[creator.user_id, creator]]) });
    render(
      <ConfigProvider
        theme={{ algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
      >
        <App>
          <AppActionsProvider value={{ onUpdateSession }}>
            <div style={{ width: Math.min(window.innerWidth, 480), height: 600 }}>
              <SessionPanel client={null} session={session} open onClose={onClose} />
            </div>
          </AppActionsProvider>
        </App>
      </ConfigProvider>
    );

    expect(screen.getByText('Waiting for approval')).toBeVisible();
    const name = screen.getByText(creator.name!);
    expect(name.parentElement!.querySelector('.ant-avatar')!.getBoundingClientRect().width).toBe(
      16
    );
    const more = screen.getByRole('button', { name: 'More actions' });
    await waitFor(() => {
      expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
        more.getBoundingClientRect().left
      );
    });
    await userEvent.hover(name);
    await waitFor(() => expect(screen.getByText(`Created by ${creator.name}`)).toBeVisible());

    await userEvent.click(screen.getByRole('button', { name: /Review panel headers/ }));
    const input = screen.getByPlaceholderText('Untitled session');
    expect(getComputedStyle(input).fontSize).toBe('16px');
    await userEvent.fill(input, 'Renamed session');
    await userEvent.keyboard('{Enter}');
    expect(onUpdateSession).toHaveBeenCalledWith(session.session_id, { title: 'Renamed session' });

    const mobile = window.innerWidth < MOBILE_SHELL_MAX_WIDTH;
    const close = screen.getByRole('button', {
      name: mobile ? 'Close' : 'Close panel',
    });
    const search = screen.getByRole('button', { name: 'Search session' });
    if (mobile) {
      for (const button of [close, more, search]) {
        expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
    }
    await userEvent.click(search);
    expect(screen.getByPlaceholderText('Search session...')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  }
);

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
  environment_config: {
    up_command: 'pnpm dev',
    down_command: 'pnpm stop',
    logs_command: 'docker compose logs',
  },
} as Repo;
const branch = {
  branch_id: 'branch-1',
  repo_id: repo.repo_id,
  name: 'test-branch',
  environment_instance: {
    status: 'running',
    access_urls: [{ name: 'App', url: 'https://app.example.test' }],
  },
} as Branch;

function renderWithBranch(
  withBranch: Branch,
  actions: Record<string, ReturnType<typeof vi.fn>>,
  connected = true
) {
  agorStore.setState({ repoById: new Map([[repo.repo_id, repo]]) });
  const session = {
    session_id: 'session-1',
    agentic_tool: 'claude-code',
    title: 'Branch menu',
    status: 'running',
  } as unknown as Session;
  render(
    <ConnectionProvider
      value={{
        connected,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <App>
        <AppActionsProvider value={actions}>
          <div style={{ width: Math.min(window.innerWidth, 480), height: 600 }}>
            <SessionPanel
              client={null}
              session={session}
              branch={withBranch}
              open
              onClose={vi.fn()}
            />
          </div>
        </AppActionsProvider>
      </App>
    </ConnectionProvider>
  );
}

it('names the branch under the title and moves the branch strip into the menu', async () => {
  const actions = {
    onOpenBranch: vi.fn(),
    onStartEnvironment: vi.fn(),
    onStopEnvironment: vi.fn(),
    onViewLogs: vi.fn(),
  };
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  renderWithBranch(branch, actions);
  expect(screen.getByText('test-branch')).toBeVisible();
  expect(screen.getByText('Running')).toBeVisible();

  const menu = async () => {
    await waitFor(() =>
      expect(document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')).toBeNull()
    );
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await waitFor(() => expect(screen.getByRole('menu')).toBeVisible());
  };
  await menu();
  await userEvent.click(screen.getByText('Open app'));
  expect(open).toHaveBeenCalledWith('https://app.example.test', '_blank', 'noopener,noreferrer');

  for (const [label, tab] of [
    ['Branch details', undefined],
    ['Sessions', 'sessions'],
    ['Files', 'files'],
    ['Schedule', 'schedule'],
    ['Edit branch', undefined],
  ] as const) {
    await menu();
    await userEvent.click(screen.getByRole('menuitem', { name: new RegExp(`${label}$`) }));
    expect(actions.onOpenBranch).toHaveBeenLastCalledWith(branch.branch_id, tab);
  }

  await menu();
  await userEvent.click(await screen.findByRole('menuitem', { name: /Environment Running/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /Stop environment$/ }));
  expect(actions.onStopEnvironment).toHaveBeenCalledWith(branch.branch_id);
  expect(screen.queryByText('Nuke environment')).toBeNull();
  open.mockRestore();
});

it('marks the menu when the environment failed and disables control while disconnected', async () => {
  const onStartEnvironment = vi.fn();
  renderWithBranch(
    { ...branch, environment_instance: { status: 'error' } } as Branch,
    { onOpenBranch: vi.fn(), onStartEnvironment },
    false
  );
  const more = screen.getByRole('button', { name: 'More actions, environment failed' });
  expect(more.closest('.ant-badge')?.querySelector('.ant-badge-dot')).not.toBeNull();
  await userEvent.click(more);
  await userEvent.click(await screen.findByRole('menuitem', { name: /Environment Failed/ }));
  const start = await screen.findByRole('menuitem', { name: /Start environment/ });
  expect(start).toHaveAttribute('aria-disabled', 'true');
});
