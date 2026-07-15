import type { Branch, Repo } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    Spin: () => React.createElement('span', null, 'loading'),
    Tooltip: ({
      children,
      trigger,
    }: {
      children: React.ReactNode;
      trigger?: string | string[];
    }) => {
      if (!React.isValidElement(children)) {
        return React.createElement(React.Fragment, null, children);
      }

      return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'data-tooltip-trigger': Array.isArray(trigger) ? trigger.join(',') : trigger,
      });
    },
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
          colorBorderSecondary: '#ddd',
          colorError: '#f00',
          colorInfo: '#00f',
          colorSuccess: '#0a0',
          colorTextDisabled: '#999',
          colorWarning: '#fa0',
          fontFamilyCode: 'monospace',
          fontSizeSM: 12,
        },
      }),
    },
  };
});

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    role: 'admin',
    isAdmin: true,
    isSuperAdmin: false,
    hasRole: () => true,
  }),
}));

vi.mock('../../hooks/useConfirmNukeEnvironment', () => ({
  useConfirmNukeEnvironment: () => vi.fn(),
}));

import { BranchHeaderPill } from './BranchHeaderPill';

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
  others_can: 'all',
  environment_instance: { status: 'stopped' },
} as Branch;

const defaultProps = {
  repo,
  branch,
  onOpenBranch: vi.fn(),
  onStartEnvironment: vi.fn(),
  onStopEnvironment: vi.fn(),
  onViewLogs: vi.fn(),
  onNukeEnvironment: vi.fn(),
};

describe('BranchHeaderPill', () => {
  it('keeps compact fluid actions at the default width and hides the destructive action', () => {
    render(<BranchHeaderPill {...defaultProps} compact fluid />);

    expect(
      screen.getByRole('button', {
        name: 'preset-io/agor / feature/remove-nuke · Open branch settings',
      })
    ).toHaveAttribute('data-tooltip-trigger', 'hover,focus');
    expect(screen.getByRole('button', { name: 'Start environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View environment logs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuke environment' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveStyle({
      width: '22px',
      minWidth: '22px',
    });
  });

  it('keeps the destructive nuke action in non-compact mode', () => {
    render(<BranchHeaderPill {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Nuke environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start environment' })).toHaveStyle({
      width: '22px',
      minWidth: '22px',
    });
  });

  it('can explicitly hide only the destructive nuke action', () => {
    render(<BranchHeaderPill {...defaultProps} showNukeEnvironment={false} />);

    expect(screen.getByRole('button', { name: 'Start environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop environment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View environment logs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuke environment' })).not.toBeInTheDocument();
  });

  it('uses the supplied identity link for the branch identity area', () => {
    render(<BranchHeaderPill {...defaultProps} identityLink="https://agor.example/ui/s/abc123/" />);

    const link = screen.getByRole('link', {
      name: 'preset-io/agor / feature/remove-nuke · Open session',
    });
    expect(link).toHaveAttribute('href', 'https://agor.example/ui/s/abc123/');
    expect(link).toHaveAttribute('data-tooltip-trigger', 'hover,focus');
  });

  it('renders basename-aware internal identity links', () => {
    render(
      <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
        <BranchHeaderPill {...defaultProps} identityLink="/s/abc123/" />
      </MemoryRouter>
    );

    const link = screen.getByRole('link', {
      name: 'preset-io/agor / feature/remove-nuke · Open session',
    });
    expect(link).toHaveAttribute('href', '/ui/s/abc123/');
  });

  it('keeps a fluid identity accessible and selects the narrow action-button variant', () => {
    render(
      <BranchHeaderPill {...defaultProps} identityLink="https://agor.example/ui/s/abc123/" fluid />
    );

    const identity = screen.getByRole('link', {
      name: 'preset-io/agor / feature/remove-nuke · Open session',
    });
    expect(identity).toHaveAttribute('data-tooltip-trigger', 'hover,focus');
    expect(identity).toHaveStyle({
      flex: '1 1 auto',
      minWidth: '0',
    });
    expect(identity.parentElement).toHaveStyle({
      width: '100%',
      minWidth: '0',
    });

    expect(screen.getByText(repo.slug)).toHaveStyle({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    expect(screen.getByText(branch.name)).toHaveStyle({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });

    expect(screen.getByRole('button', { name: 'Start environment' }).parentElement).toHaveStyle({
      flexShrink: '0',
    });
    expect(screen.getByRole('button', { name: 'Sessions' }).parentElement).toHaveStyle({
      flexShrink: '0',
    });

    for (const name of [
      'Start environment',
      'Stop environment',
      'View environment logs',
      'Nuke environment',
      'Sessions',
      'Files',
      'Schedule',
      'Edit branch',
    ]) {
      expect(screen.getByRole('button', { name })).toHaveStyle({
        height: '22px',
        width: '20px',
        minWidth: '20px',
      });
    }
  });
});
