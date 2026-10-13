import type { Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';

vi.mock('antd', async () => {
  const React = await import('react');

  return {
    Button: ({
      children,
      icon,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) =>
      React.createElement('button', props, icon, children),
    Space: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Spin: () => React.createElement('span', null, 'loading'),
    Tooltip: ({ children, title }: { children: React.ReactNode; title?: React.ReactNode }) =>
      React.createElement(
        React.Fragment,
        null,
        children,
        React.createElement('span', { 'data-testid': 'tooltip' }, title)
      ),
    Tag: Object.assign(
      ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
        React.createElement('span', props, children),
      {
        CheckableTag: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
          React.createElement('span', props, children),
      }
    ),
    theme: {
      useToken: () => ({
        token: {
          colorError: '#f00',
          colorInfo: '#00f',
          colorSuccess: '#0a0',
          colorTextDisabled: '#999',
          colorWarning: '#fa0',
          fontFamilyCode: 'monospace',
        },
      }),
    },
  };
});

vi.mock('../../hooks/useConfirmNukeEnvironment', () => ({
  useConfirmNukeEnvironment: () => vi.fn(),
}));

import { EnvironmentPill } from './EnvironmentPill';

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
  environment_config: {
    up_command: 'pnpm dev',
    down_command: 'pnpm stop',
    nuke_command: 'docker compose down -v',
    logs_command: 'docker compose logs',
  },
} as Repo;

const branch = {
  branch_id: 'branch-1',
  repo_id: repo.repo_id,
  name: 'feature/remove-nuke',
  nuke_command: 'docker compose down -v',
  environment_instance: { status: 'stopped' },
} as Branch;

const defaultProps = {
  repo,
  branch,
  onEdit: vi.fn(),
  onStartEnvironment: vi.fn(),
  onStopEnvironment: vi.fn(),
  onViewLogs: vi.fn(),
  onNukeEnvironment: vi.fn(),
};

describe('EnvironmentPill', () => {
  beforeEach(() => {
    __setAuthConfigForTests({ requireAuth: true });
  });

  it('opens command-only logs while retaining the branch permission gate', () => {
    const onViewLogs = vi.fn();
    const commandOnly = {
      ...branch,
      environment_instance: { status: 'error', last_error: 'Launch failed' },
    } as Branch;
    const props = { ...defaultProps, branch: commandOnly, onViewLogs };
    const { rerender } = render(<EnvironmentPill {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'View environment logs' }));
    expect(onViewLogs).toHaveBeenCalledWith(branch.branch_id);
    onViewLogs.mockClear();
    rerender(<EnvironmentPill {...props} canControlEnvironment={false} />);
    const button = screen.getByRole('button', { name: 'View environment logs' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onViewLogs).not.toHaveBeenCalled();
  });

  it('uses the rendered branch logs command and respects shell-log availability', () => {
    __setAuthConfigForTests(
      { requireAuth: true },
      { environmentCommands: { asynchronous: true, shellLogs: false } }
    );
    const { rerender } = render(<EnvironmentPill {...defaultProps} />);
    // A repo default is not evidence that this branch variant has runtime logs.
    expect(screen.getByRole('button', { name: 'View environment logs' })).toBeDisabled();
    rerender(
      <EnvironmentPill {...defaultProps} branch={{ ...branch, logs_command: 'preview logs' }} />
    );
    expect(screen.getByRole('button', { name: 'View environment logs' })).toBeDisabled();
    rerender(
      <EnvironmentPill
        {...defaultProps}
        branch={{ ...branch, logs_command: 'https://example.test/logs' }}
      />
    );
    expect(screen.getByRole('button', { name: 'View environment logs' })).not.toBeDisabled();
    rerender(
      <EnvironmentPill
        {...defaultProps}
        branch={{
          ...branch,
          logs_command: 'preview logs',
          environment_instance: {
            status: 'error',
            last_error: 'Launch failed',
          },
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'View environment logs' })).not.toBeDisabled();
  });

  it('opens the reported URL and permits Stop retry only after an attempt settles', () => {
    const running = {
      ...branch,
      app_url: 'https://static.example.test',
      environment_instance: {
        status: 'running',
        access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
      },
    } as Branch;
    const { rerender } = render(<EnvironmentPill {...defaultProps} branch={running} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://preview.example.test');
    const failed = {
      ...branch,
      environment_instance: {
        status: 'error',
        command_attempt: { id: 'attempt', finished_at: 'done' },
      },
    } as Branch;
    rerender(<EnvironmentPill {...defaultProps} branch={failed} />);
    expect(screen.getByRole('button', { name: 'Stop environment' })).not.toBeDisabled();
    const active = {
      ...branch,
      environment_instance: { status: 'starting', command_attempt: { id: 'attempt' } },
    } as Branch;
    rerender(<EnvironmentPill {...defaultProps} branch={active} />);
    expect(screen.getByRole('button', { name: 'Stop environment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nuke environment' })).toBeDisabled();
  });

  it('uses an Ant Design button for the unconfigured environment action', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        repo={{ repo_id: 'repo-unconfigured', slug: 'preset-io/unconfigured' } as Repo}
      />
    );

    expect(screen.getByRole('button', { name: 'Configure environment' })).toHaveTextContent('env');
  });

  it('shows a pointer only when the environment label links to a running app', () => {
    const { rerender } = render(
      <EnvironmentPill
        {...defaultProps}
        branch={
          {
            ...branch,
            app_url: 'https://example.test',
            environment_instance: { status: 'running' },
          } as Branch
        }
      />
    );

    expect(screen.getByRole('link')).toHaveStyle({ cursor: 'pointer' });

    rerender(<EnvironmentPill {...defaultProps} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('env').parentElement).toHaveStyle({ cursor: 'default' });
  });

  it('uses a dynamic environment instance URL before the static branch URL', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        branch={
          {
            ...branch,
            app_url: 'https://static.example.test',
            environment_instance: {
              status: 'running',
              access_urls: [{ name: 'App', url: 'https://dynamic.example.test' }],
            },
          } as Branch
        }
      />
    );

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://dynamic.example.test');
    expect(screen.getByLabelText('Health unavailable')).toBeInTheDocument();
  });

  it('links to the static provider fallback while Start is still discovering runtime URLs', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        branch={
          {
            ...branch,
            app_url: 'https://github.com/codespaces',
            environment_instance: { status: 'starting' },
          } as Branch
        }
      />
    );

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://github.com/codespaces');
  });

  it('shows a pointer only for an enabled configure control', () => {
    const { rerender } = render(<EnvironmentPill {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Configure environment' })).toHaveStyle({
      cursor: 'pointer',
    });

    rerender(<EnvironmentPill {...defaultProps} onEdit={undefined} />);

    const configureButton = screen.getByRole('button', { name: 'Configure environment' });
    expect(configureButton).toBeDisabled();
    expect(configureButton).not.toHaveStyle({ cursor: 'pointer' });
  });

  it('can hide only the destructive nuke action while preserving other controls', () => {
    render(<EnvironmentPill {...defaultProps} showNukeEnvironment={false} />);

    expect(screen.getByRole('button', { name: 'Start environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View environment logs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuke environment' })).not.toBeInTheDocument();
  });

  it('shows the destructive nuke action by default when configured', () => {
    render(<EnvironmentPill {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Nuke environment' })).toBeInTheDocument();
  });

  it('surfaces the active variant name when the repo defines multiple variants', () => {
    const multiVariantRepo = {
      repo_id: 'repo-2',
      slug: 'tzercin/agor',
      environment: {
        version: 2,
        default: 'sqlite',
        variants: {
          sqlite: { start: 'pnpm dev', stop: 'pnpm stop' },
          postgres: { start: 'pnpm dev:pg', stop: 'pnpm stop' },
        },
      },
    } as unknown as Repo;
    const pgBranch = {
      ...branch,
      environment_variant: 'postgres',
    } as Branch;

    render(<EnvironmentPill {...defaultProps} repo={multiVariantRepo} branch={pgBranch} />);

    expect(screen.getByText('postgres')).toBeInTheDocument();
    expect(screen.queryByText('env')).not.toBeInTheDocument();
  });

  it('falls back to the generic "env" label when only one variant exists', () => {
    const singleVariantRepo = {
      repo_id: 'repo-3',
      slug: 'tzercin/agor',
      environment: {
        version: 2,
        default: 'default',
        variants: {
          default: { start: 'pnpm dev', stop: 'pnpm stop' },
        },
      },
    } as unknown as Repo;
    const singleBranch = {
      ...branch,
      environment_variant: 'default',
    } as Branch;

    render(<EnvironmentPill {...defaultProps} repo={singleVariantRepo} branch={singleBranch} />);

    expect(screen.getByText('env')).toBeInTheDocument();
    expect(screen.queryByText('default')).not.toBeInTheDocument();
  });

  const tooltips = () => screen.getAllByTestId('tooltip').map((node) => node.textContent);
  const settled = (action: 'start' | 'stop' | 'nuke', outcome: 'failed' | 'unknown'): Branch =>
    ({
      ...branch,
      environment_instance: {
        status: 'error',
        command_attempt: { id: 'attempt', action, finished_at: 'done' },
        last_command: { action, status: outcome, timestamp: 'done', message: 'exit 1' },
      },
    }) as Branch;

  it.each([
    {
      shape: 'failed start',
      branch: settled('start', 'failed'),
      icon: 'close-circle',
      logs: 'View environment logs',
      status: "The environment didn't start. Check the logs.",
      stop: 'Stop environment',
    },
    {
      shape: 'failed stop',
      branch: settled('stop', 'failed'),
      icon: 'close-circle',
      logs: 'View environment logs',
      status: "The environment didn't stop. Check the logs.",
      stop: "Stop again. The environment didn't stop.",
    },
    {
      shape: 'unconfirmed stop',
      branch: settled('stop', 'unknown'),
      icon: 'warning',
      logs: 'View environment logs',
      status: "Agor couldn't confirm the last stop. Check the logs before you try again.",
      stop: "Stop again. Agor couldn't confirm the last stop.",
    },
    {
      shape: 'failed nuke',
      branch: settled('nuke', 'failed'),
      icon: 'close-circle',
      logs: 'View environment logs',
      status: "The nuke didn't finish. Check the logs.",
      stop: 'Stop environment',
    },
    {
      shape: 'stopped',
      branch,
      icon: 'stop',
      logs: 'No logs yet.',
      status: 'Stopped',
      stop: 'Environment not running',
    },
  ])(
    'describes a $shape environment by its last action',
    ({ branch, icon, logs, status, stop }) => {
      render(<EnvironmentPill {...defaultProps} branch={branch} />);
      expect(tooltips()).toEqual([
        status,
        'Start environment',
        stop,
        logs,
        'Nuke environment. This removes all its data and volumes.',
        'Configure environment',
      ]);
      // The severity shows in the status icon: amber for an unconfirmed outcome.
      const statusIcon = within(screen.getByText('env').parentElement!).getByRole('img');
      expect(statusIcon).toHaveAttribute('aria-label', icon);
    }
  );

  it('describes an unhealthy environment without its URL', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        branch={
          {
            ...branch,
            environment_instance: {
              status: 'running',
              last_health_check: { status: 'unhealthy', timestamp: 'now', message: 'HTTP 503' },
            },
          } as Branch
        }
      />
    );
    expect(tooltips()[0]).toBe('Running, but the health check failed. (HTTP 503)');
  });

  it('explains the unconfigured pill', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        repo={{ repo_id: 'repo-unconfigured', slug: 'preset-io/unconfigured' } as Repo}
      />
    );
    expect(tooltips()).toEqual(['No environment set up yet. Use the edit button to add one.']);
  });

  it('gives the no-permission reason only when control is denied', () => {
    const noControl = 'You need full control of this branch to control its environment.';
    const { rerender } = render(<EnvironmentPill {...defaultProps} />);
    expect(tooltips()).not.toContain(noControl);
    rerender(<EnvironmentPill {...defaultProps} canControlEnvironment={false} />);
    expect(tooltips().filter((title) => title === noControl)).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Start environment' })).toBeDisabled();
  });
});
