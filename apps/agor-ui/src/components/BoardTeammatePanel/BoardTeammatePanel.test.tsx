import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoardTeammatePanel } from './BoardTeammatePanel';

const board = { board_id: 'board-1' } as Board;

const teammateBranch = (over: Partial<Branch> = {}): Branch =>
  ({
    branch_id: 'tm-1',
    board_id: 'board-2',
    repo_id: 'repo-1',
    name: 'helper',
    custom_context: { teammate: { kind: 'teammate', displayName: 'Helper Bot' } },
    ...over,
  }) as unknown as Branch;

interface MockClient {
  client: AgorClient;
  find: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  setPrimaryTeammate: ReturnType<typeof vi.fn>;
}

const makeClient = (branches: Branch[] = []): MockClient => {
  const find = vi.fn().mockResolvedValue({
    data: branches,
    total: branches.length,
    limit: 200,
    skip: 0,
  });
  const patch = vi.fn().mockResolvedValue({});
  const setPrimaryTeammate = vi.fn().mockResolvedValue({});
  const client = {
    service: (name: string) => {
      if (name === 'branches') return { find, patch };
      if (name === 'boards') return { setPrimaryTeammate };
      return {};
    },
  } as unknown as AgorClient;
  return { client, find, patch, setPrimaryTeammate };
};

const renderPanel = (props: Partial<ComponentProps<typeof BoardTeammatePanel>> = {}) =>
  render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="comments"
        onTabChange={vi.fn()}
        primaryTeammateInaccessible={false}
        onSessionClick={vi.fn()}
        client={null}
        {...props}
      />
    </AntApp>
  );

describe('BoardTeammatePanel controlled tabs', () => {
  it('does not reset a controlled Comments tab to the default tab on mount', () => {
    const onTabChange = vi.fn();

    renderPanel({ onTabChange });

    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe('BoardTeammatePanel empty state', () => {
  it('renders a Create teammate button when onCreateTeammate is provided', () => {
    const onCreateTeammate = vi.fn();

    renderPanel({ activeTab: 'teammate', onCreateTeammate });

    expect(screen.getByRole('button', { name: /create teammate/i })).toBeInTheDocument();
  });

  it('calls onCreateTeammate when the Create teammate button is clicked', () => {
    const onCreateTeammate = vi.fn();

    renderPanel({ activeTab: 'teammate', onCreateTeammate });

    fireEvent.click(screen.getByRole('button', { name: /create teammate/i }));
    expect(onCreateTeammate).toHaveBeenCalledOnce();
  });

  it('does not render a Create teammate button when onCreateTeammate is absent', () => {
    renderPanel({ activeTab: 'teammate' });

    expect(screen.queryByRole('button', { name: /create teammate/i })).not.toBeInTheDocument();
  });
});

describe('BoardTeammatePanel teammate fetch', () => {
  it('does not fetch teammate branches when a primary teammate already exists', async () => {
    const { client, find } = makeClient([teammateBranch()]);

    renderPanel({
      client,
      primaryTeammateBranch: teammateBranch({ branch_id: 'primary-1', board_id: 'board-1' }),
      primaryTeammateRepo: { repo_id: 'repo-1', slug: 'repo' } as Repo,
    });

    // Hot-path gating: with a primary teammate assigned there is nothing to
    // assign, so the cross-board branch list must not be fetched.
    await Promise.resolve();
    expect(find).not.toHaveBeenCalled();
  });

  it('assigns a cross-board teammate resolved from the fetched list', async () => {
    // The teammate lives on a different board and is NOT in the board-scoped
    // branchById store, so it can only be resolved via the fetched list.
    const branch = teammateBranch({ branch_id: 'tm-42', board_id: 'board-2' });
    const { client, find, patch, setPrimaryTeammate } = makeClient([branch]);

    renderPanel({ activeTab: 'teammate', client });

    expect(find).toHaveBeenCalledTimes(1);

    const assignButton = await screen.findByRole('button', { name: /^assign$/i });
    await waitFor(() => expect(assignButton).toBeEnabled());

    fireEvent.click(assignButton);

    // Cross-board assign moves the branch onto this board, then promotes it.
    await waitFor(() => expect(patch).toHaveBeenCalledWith('tm-42', { board_id: 'board-1' }));
    expect(setPrimaryTeammate).toHaveBeenCalledWith({
      boardId: 'board-1',
      branchId: 'tm-42',
    });
  });
});
