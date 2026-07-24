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
});
