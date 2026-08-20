import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { PrimaryTeammatePicker } from './PrimaryTeammatePicker';

function teammate(id: string, displayName: string, overrides?: Partial<Branch>): Branch {
  return {
    branch_id: id,
    repo_id: 'repo-1',
    name: `${id}-branch`,
    board_id: 'board-1',
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName } },
    ...overrides,
  } as unknown as Branch;
}

const board = { board_id: 'board-1', name: 'Ambient', icon: '📋' } as Board;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

function seedStore(branches: Branch[]) {
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    boardById: new Map([[board.board_id, board]]),
    repoById: new Map([[repo.repo_id, repo]]),
  });
}

function createClient(current: Branch | null) {
  const getPrimaryTeammate = vi.fn().mockResolvedValue(current);
  const setPrimaryTeammate = vi.fn((data: { branchId: string }) =>
    Promise.resolve(teammate(data.branchId, data.branchId))
  );
  const client = {
    service: (name: string) => {
      if (name === 'users') return { getPrimaryTeammate, setPrimaryTeammate };
      throw new Error(`unexpected service ${name}`);
    },
  } as unknown as AgorClient;
  return { client, getPrimaryTeammate, setPrimaryTeammate };
}

function renderPicker(client: AgorClient) {
  return render(
    <AntApp>
      <PrimaryTeammatePicker client={client} />
    </AntApp>
  );
}

describe('PrimaryTeammatePicker', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('shows the current board-level primary with its board context', async () => {
    const current = teammate('branch-1', 'Ada');
    seedStore([current, teammate('branch-2', 'Grace')]);
    renderPicker(createClient(current).client);

    const currently = await screen.findByText(/Currently/);
    expect(currently).toHaveTextContent('Ada');
    expect(currently).toHaveTextContent('Ambient');
  });

  it('renders a primary that lives outside the listed teammates', async () => {
    // Resolved primary is accessible but not among the store's teammate list
    // (embedded on a board the picker isn't otherwise surfacing).
    const elsewhere = teammate('branch-remote', 'Remote Pilot', { board_id: undefined });
    seedStore([teammate('branch-2', 'Grace')]);
    renderPicker(createClient(elsewhere).client);

    const currently = await screen.findByText(/Currently/);
    expect(currently).toHaveTextContent('Remote Pilot');
    // Board unknown → falls back to the repo slug.
    expect(currently).toHaveTextContent('preset-io/agor');
  });

  it('shows the no-primary prompt instead of a blank field when unset', async () => {
    seedStore([teammate('branch-2', 'Grace')]);
    renderPicker(createClient(null).client);

    expect(await screen.findByText(/No primary assistant set/)).toBeInTheDocument();
  });

  it('does not present an archived stored branch as a valid primary assistant', async () => {
    const archived = teammate('branch-old', 'Old', { archived: true });
    seedStore([archived, teammate('branch-2', 'Grace')]);
    renderPicker(createClient(archived).client);

    expect(await screen.findByText(/No primary assistant set/)).toBeInTheDocument();
    expect(screen.queryByText(/Currently/)).not.toBeInTheDocument();
  });

  it('writes the picked teammate as an explicit change', async () => {
    seedStore([teammate('branch-1', 'Ada'), teammate('branch-2', 'Grace')]);
    const { client, setPrimaryTeammate } = createClient(null);
    renderPicker(client);

    await screen.findByText(/No primary assistant set/);
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('Grace'));

    await waitFor(() => expect(setPrimaryTeammate).toHaveBeenCalledWith({ branchId: 'branch-2' }));
    // Named confirmation toast on a successful pick.
    expect(await screen.findByText(/Primary assistant set to/)).toBeInTheDocument();
  });
});
