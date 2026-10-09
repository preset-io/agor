import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ mode }: { mode?: string }) => (
    <div data-testid="teammate-session-sections">mode:{String(mode)}</div>
  ),
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: ({ truncateToFit }: { truncateToFit?: boolean }) => (
    <div data-testid="branch-header-pill" data-truncate-to-fit={String(truncateToFit)} />
  ),
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const primaryTeammateBranch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
} as Branch;
const primaryTeammateRepo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

describe('BoardTeammatePanel teammate tab', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('renders the teammate Sessions section as a transient panel surface', () => {
    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('teammate-session-sections')).toHaveTextContent('mode:panel');
    expect(screen.getByTestId('branch-header-pill')).toHaveAttribute(
      'data-truncate-to-fit',
      'true'
    );
  });

  it('shows a loading skeleton, not an empty or inaccessible state, until the board is ready', () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <AntApp>
        <BoardTeammatePanel
          board={{ ...board, primary_teammate_id: 'branch-1' } as Board}
          onTabChange={onTabChange}
          primaryTeammateInaccessible={false}
          boardReady={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('board-partition-skeleton')).toBeInTheDocument();
    expect(
      screen.queryByText("You don't have access to this board's teammate.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("This board doesn't have a primary teammate yet.")
    ).not.toBeInTheDocument();
    expect(onTabChange).not.toHaveBeenCalledWith('all-sessions');

    rerender(
      <AntApp>
        <BoardTeammatePanel
          board={{ ...board, primary_teammate_id: 'branch-1' } as Board}
          onTabChange={onTabChange}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          boardReady
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );
    expect(screen.queryByTestId('board-partition-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('teammate-session-sections')).toBeInTheDocument();
    expect(onTabChange).not.toHaveBeenCalledWith('all-sessions');
  });
});

describe('BoardTeammatePanel primary teammate missing from the store', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      repoById: new Map([[primaryTeammateRepo.repo_id, primaryTeammateRepo]]),
    });
  });

  function renderMissing(get: (id: string) => Promise<Branch>) {
    const client = {
      service: (path: string) => (path === 'branches' ? { get } : {}),
    } as unknown as AgorClient;
    render(
      <AntApp>
        <BoardTeammatePanel
          board={{ ...board, primary_teammate_id: primaryTeammateBranch.branch_id } as Board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateInaccessible
          onSessionClick={vi.fn()}
          client={client}
        />
      </AntApp>
    );
  }
  const withCode = (message: string, code: number) => Object.assign(new Error(message), { code });

  it.each([
    {
      shape: '403',
      get: () => Promise.reject(withCode('Forbidden', 403)),
      message: "You don't have access to this board's teammate.",
    },
    {
      shape: '404',
      get: () => Promise.reject(withCode('Branch not found', 404)),
      message: "You don't have access to this board's teammate.",
    },
    {
      shape: 'archived',
      get: () => Promise.resolve({ ...primaryTeammateBranch, archived: true }),
      message: "This board's teammate is archived.",
    },
  ])('$shape: $message', async ({ get, message }) => {
    renderMissing(get);
    expect(screen.getByTestId('board-partition-skeleton')).toBeInTheDocument();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers Try again when the lookup fails for another reason', async () => {
    const get = vi
      .fn<(id: string) => Promise<Branch>>()
      .mockRejectedValueOnce(new Error('Request timed out'))
      .mockResolvedValueOnce({ ...primaryTeammateBranch, archived: false });
    renderMissing(get);
    expect(await screen.findByText("Couldn't load this board's teammate.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('teammate-session-sections')).toBeInTheDocument();
  });
});
