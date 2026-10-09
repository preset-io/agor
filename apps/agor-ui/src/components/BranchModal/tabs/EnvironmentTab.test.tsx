import type { BranchEnvironmentInstance } from '@agor/core/types';
import type { AgorClient, Branch, Repo } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../../hooks/useAuthConfig';
import { EnvironmentTab } from './EnvironmentTab';

const permissions = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: () => permissions }));
vi.mock('../../CodeEditor', () => ({ CodeEditor: () => null }));

const failure: BranchEnvironmentInstance = {
  status: 'error',
  last_error: 'start command exited with code 1',
  last_health_check: {
    status: 'unknown',
    timestamp: '2026-10-02T21:48:00Z',
    message: 'No health check configured',
  },
  last_command: {
    action: 'start',
    status: 'failed',
    timestamp: '2026-10-02T21:47:30Z',
    message: 'start command exited with code 1',
    output: 'Cannot resolve the pushed public GitHub branch. Push it before Start.',
  },
};
const branch = {
  branch_id: 'branch-a',
  name: 'preview',
  environment_variant: 'railway-sqlite',
  start_command: 'preview start',
  environment_instance: failure,
} as Branch;
const repo: Repo = {
  repo_id: 'repo-a' as Repo['repo_id'],
  slug: 'test-repo',
  name: 'Test repo',
  repo_type: 'local',
  local_path: '/test-repo',
  created_at: '2026-10-02T21:47:00Z',
  last_updated: '2026-10-02T21:47:00Z',
  environment: {
    version: 2,
    default: 'railway-sqlite',
    variants: { 'railway-sqlite': { start: 'preview start', stop: 'preview stop' } },
  },
};

describe('EnvironmentTab diagnostics', () => {
  afterEach(() => {
    cleanup();
    permissions.isAdmin = true;
  });

  beforeEach(() => {
    __setAuthConfigForTests(
      { requireAuth: true },
      {
        environmentCommands: {
          asynchronous: true,
          shellLogs: false,
          shellLogsReason: 'Runtime logs unavailable on this instance.',
        },
      }
    );
  });

  function setup(canControlEnvironment: boolean | undefined, testBranch = branch) {
    const on = vi.fn();
    const client = { service: () => ({ on, removeListener: vi.fn() }) } as unknown as AgorClient;
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
        <App>
          <EnvironmentTab
            branch={testBranch}
            repo={repo}
            client={client}
            canControlEnvironment={canControlEnvironment}
          />
        </App>
      </ConfigProvider>
    );
    return on;
  }

  it('shows one compact failure, collapses guidance, and opens the actionable output in Logs', async () => {
    setup(true);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveAttribute('data-notice-type', 'error');
    expect(
      within(screen.getByRole('alert')).getByText("The environment didn't start.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cannot resolve the pushed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retry Stop to request cleanup/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No health check configured/)).not.toBeInTheDocument();
    const guidance = screen.getByRole('button', { name: 'About remote environments' });
    expect(guidance).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(guidance);
    await waitFor(() => expect(screen.getByText(/Commands run remotely/)).toBeVisible());
    expect(screen.getByText('Restart').closest('button')!).toBeDisabled();
    // No runtime logs command: persisted launcher output must still be reachable.
    fireEvent.click(screen.getByText('View Logs').closest('button')!);
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByText(/Cannot resolve the pushed/)).toBeVisible()
    );
  });

  it('does not weaken environment control permissions to expose the logs button', async () => {
    setup(false);
    expect(screen.getByText('View Logs').closest('button')!).toBeDisabled();
    expect(screen.getByText('Start').closest('button')!).toBeDisabled();
    expect(screen.getByText('Start').closest('button')!).toHaveAttribute(
      'title',
      'You need full control of this branch to control its environment.'
    );
  });

  it('does not claim missing permission when access was not decided', () => {
    permissions.isAdmin = false;
    setup(undefined);
    expect(screen.getByText('Start').closest('button')!).toBeDisabled();
    expect(screen.getByText('Start').closest('button')!).not.toHaveAttribute('title');
  });

  it.each([
    {
      shape: 'stale last_error on a stopped environment',
      environment: { status: 'stopped', last_error: 'old failure' },
      notice: null,
    },
    {
      shape: 'error without a command',
      environment: { status: 'error', last_error: 'spawn ENOENT' },
      notice: { type: 'error', message: 'The environment reported an error.' },
    },
    {
      shape: 'unhealthy running environment',
      environment: {
        status: 'running',
        last_health_check: { status: 'unhealthy', timestamp: 'now', message: 'HTTP 503' },
      },
      notice: { type: 'warning', message: 'Running, but the health check failed.' },
    },
  ] satisfies Array<{
    shape: string;
    environment: BranchEnvironmentInstance;
    notice: { type: string; message: string } | null;
  }>)('shows the right banner for $shape', ({ environment, notice }) => {
    setup(true, { ...branch, environment_instance: environment });
    if (!notice) {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      return;
    }
    expect(screen.getByRole('alert')).toHaveAttribute('data-notice-type', notice.type);
    expect(within(screen.getByRole('alert')).getByText(notice.message)).toBeInTheDocument();
  });

  it('keeps status and command logs synchronized with same-branch patches only', async () => {
    const on = setup(true);
    const update = on.mock.calls.find(([event]) => event === 'patched')?.[1];
    const patched: Branch = {
      ...branch,
      environment_instance: {
        ...failure,
        last_command: {
          ...failure.last_command!,
          action: 'stop',
          status: 'unknown',
          output: 'Cleanup result unavailable',
        },
      },
    };
    act(() => update({ ...patched, branch_id: 'branch-b' }));
    expect(screen.getByRole('alert')).toHaveTextContent("The environment didn't start.");
    act(() => update(patched));
    expect(screen.getByRole('alert')).toHaveAttribute('data-notice-type', 'warning');
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Agor couldn't confirm the environment stopped. Check the logs before you try again."
    );
    fireEvent.click(screen.getByText('View Logs').closest('button')!);
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog')).getByText('Cleanup result unavailable')
      ).toBeVisible()
    );
  });
});
