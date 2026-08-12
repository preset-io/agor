import type { Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIModeProvider } from '../../contexts/UIModeContext';

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
  sessionCount: 3,
  onOpenBranch: vi.fn(),
  onStartEnvironment: vi.fn(),
  onStopEnvironment: vi.fn(),
  onViewLogs: vi.fn(),
  onNukeEnvironment: vi.fn(),
};

const renderSlim = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <UIModeProvider>{ui}</UIModeProvider>
    </MemoryRouter>
  );

describe('BranchHeaderPill (slim mode)', () => {
  beforeEach(() => {
    localStorage.setItem('agor:uiMode', 'slim');
  });

  it('renders the identity as a menu trigger without a hover tooltip', () => {
    renderSlim(<BranchHeaderPill {...defaultProps} />);

    const identity = screen.getByRole('button', { name: 'preset-io/agor / feature/remove-nuke' });
    expect(identity).toHaveAttribute('aria-haspopup', 'menu');
    // No tooltip wiring on the identity — the classic hover tooltip is gone.
    expect(identity).not.toHaveAttribute('aria-describedby');
    expect(identity).not.toHaveAttribute('data-tooltip-trigger');
    expect(
      screen.queryByRole('button', {
        name: 'preset-io/agor / feature/remove-nuke · Open branch settings',
      })
    ).not.toBeInTheDocument();
  });

  it('hides the inline action buttons but keeps the environment status chip', () => {
    renderSlim(<BranchHeaderPill {...defaultProps} />);

    expect(screen.queryByRole('button', { name: 'Start environment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop environment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View environment logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuke environment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit branch' })).not.toBeInTheDocument();

    expect(screen.getByText('env')).toBeInTheDocument();
  });

  it('opens a menu with the branch modal tabs and environment actions on click', async () => {
    renderSlim(<BranchHeaderPill {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'preset-io/agor / feature/remove-nuke' }));

    expect(await screen.findByRole('menuitem', { name: /General/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Sessions \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Environment/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Files/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Schedule/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Knowledge/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Start environment/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Stop environment/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /View logs/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Nuke environment/ })).toBeInTheDocument();
    // Non-teammate branch: no Teammate tab.
    expect(screen.queryByRole('menuitem', { name: /Teammate/ })).not.toBeInTheDocument();
  });

  it('opens the matching modal tab from the menu', async () => {
    const onOpenBranch = vi.fn();
    renderSlim(<BranchHeaderPill {...defaultProps} onOpenBranch={onOpenBranch} />);

    fireEvent.click(screen.getByRole('button', { name: 'preset-io/agor / feature/remove-nuke' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Files/ }));

    expect(onOpenBranch).toHaveBeenCalledWith('branch-1', 'files');
  });
});
