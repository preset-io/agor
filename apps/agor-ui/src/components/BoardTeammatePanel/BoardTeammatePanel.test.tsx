import type { AgorClient, Board, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
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
  patch: ReturnType<typeof vi.fn>;
  setPrimaryTeammate: ReturnType<typeof vi.fn>;
}

const makeClient = (): MockClient => {
  const patch = vi.fn().mockResolvedValue({});
  const setPrimaryTeammate = vi.fn().mockResolvedValue({});
  const client = {
    service: (name: string) => {
      if (name === 'branches') return { patch };
      if (name === 'boards') return { setPrimaryTeammate };
      return {};
    },
  } as unknown as AgorClient;
  return { client, patch, setPrimaryTeammate };
};

const seedBranches = (branches: Branch[]) => {
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
  });
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

describe('BoardTeammatePanel', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  describe('controlled tabs', () => {
    it('does not reset a controlled Comments tab to the default tab on mount', () => {
      const onTabChange = vi.fn();

      renderPanel({ onTabChange });

      expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(onTabChange).not.toHaveBeenCalled();
    });
  });

  describe('empty state', () => {
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

  describe('teammate options', () => {
    it('lists cross-board teammates from the store, not just this board', async () => {
      // The teammate lives on board-2; the store's branchById is instance-wide,
      // so it must still be offered as a move target on board-1.
      seedBranches([teammateBranch({ branch_id: 'tm-42', board_id: 'board-2' })]);
      const { client } = makeClient();

      renderPanel({ activeTab: 'teammate', client });

      const assignButton = await screen.findByRole('button', { name: /^assign$/i });
      await waitFor(() => expect(assignButton).toBeEnabled());
      expect(screen.getByText('Move an existing teammate here')).toBeInTheDocument();
    });

    it('offers nothing to move when a primary teammate already exists', () => {
      seedBranches([teammateBranch({ branch_id: 'tm-42', board_id: 'board-2' })]);
      const { client } = makeClient();

      renderPanel({
        activeTab: 'teammate',
        client,
        primaryTeammateBranch: teammateBranch({ branch_id: 'primary-1', board_id: 'board-1' }),
        primaryTeammateRepo: { repo_id: 'repo-1', slug: 'repo' } as never,
      });

      expect(screen.queryByText('Move an existing teammate here')).not.toBeInTheDocument();
    });
  });

  describe('move an existing teammate', () => {
    it('moves a cross-board teammate onto this board and promotes it', async () => {
      seedBranches([teammateBranch({ branch_id: 'tm-42', board_id: 'board-2' })]);
      const { client, patch, setPrimaryTeammate } = makeClient();

      renderPanel({ activeTab: 'teammate', client });

      const assignButton = await screen.findByRole('button', { name: /^assign$/i });
      await waitFor(() => expect(assignButton).toBeEnabled());

      fireEvent.click(assignButton);

      // Moving a teammate re-parents its single board_id, then promotes it.
      await waitFor(() => expect(patch).toHaveBeenCalledWith('tm-42', { board_id: 'board-1' }));
      expect(setPrimaryTeammate).toHaveBeenCalledWith({
        boardId: 'board-1',
        branchId: 'tm-42',
      });
    });
  });
});
