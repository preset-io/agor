import type { Branch, Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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

  it('uses the first runtime URL as primary and exposes every additional named URL', () => {
    render(
      <EnvironmentPill
        {...defaultProps}
        branch={
          {
            ...branch,
            app_url: 'https://stale-static.example.test',
            environment_instance: {
              status: 'running',
              access_urls: [
                { name: 'Shell', url: 'https://shell.example.test' },
                { name: 'Manager', url: 'https://manager.example.test' },
              ],
            },
          } as Branch
        }
      />
    );

    expect(screen.getByRole('link', { name: 'Open Shell' })).toHaveAttribute(
      'href',
      'https://shell.example.test'
    );
    expect(screen.getByRole('link', { name: 'Open Manager' })).toHaveAttribute(
      'href',
      'https://manager.example.test'
    );
    expect(screen.queryByRole('link', { name: /stale-static/ })).not.toBeInTheDocument();
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
});
