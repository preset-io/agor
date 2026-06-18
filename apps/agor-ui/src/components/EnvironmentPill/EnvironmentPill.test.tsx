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
  it('shows the destructive nuke action when nuke_command is configured', () => {
    render(<EnvironmentPill {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Nuke environment' })).toBeInTheDocument();
  });

  it('hides the destructive nuke action when nuke_command is not configured', () => {
    render(<EnvironmentPill {...defaultProps} branch={{ ...branch, nuke_command: undefined }} />);

    expect(screen.getByRole('button', { name: 'Start environment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuke environment' })).not.toBeInTheDocument();
  });
});
