import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { TeammatesDirectory } from './TeammatesDirectory';

const ME = 'user-me';
const member = { user_id: ME, name: 'Kasia', role: 'member' } as User;

const teammate = (id: string, boardId: string, owner = 'owner-1') =>
  ({
    branch_id: id,
    name: id,
    board_id: boardId,
    created_by: owner,
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: `Teammate ${id}` } },
  }) as unknown as Branch;
const board = (id: string, description?: string) =>
  ({ board_id: id, name: id, archived: false, description }) as Board;

function seed(branches: Branch[], boards: Board[]) {
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    boardById: new Map(boards.map((b) => [b.board_id, b])),
  } as never);
}

function renderDirectory(props: Partial<React.ComponentProps<typeof TeammatesDirectory>> = {}) {
  return render(
    <AntApp>
      <MemoryRouter>
        <TeammatesDirectory
          client={null}
          currentUser={member}
          onOpenBoard={vi.fn()}
          onBack={vi.fn()}
          {...props}
        />
      </MemoryRouter>
    </AntApp>
  );
}

beforeEach(() => agorStore.getState().reset());

describe('TeammatesDirectory', () => {
  it('lists teammates on boards the server returned, never private or own ones', () => {
    // A board that went private for this viewer is no longer in their store.
    seed(
      [
        teammate('shared', 'b-shared'),
        teammate('went-private', 'b-gone'),
        teammate('mine', 'b-mine', ME),
      ],
      [board('b-shared', 'Triages the board'), board('b-mine')]
    );
    renderDirectory();
    expect(screen.getByText('Teammate shared')).toBeInTheDocument();
    expect(screen.getByText('Triages the board')).toBeInTheDocument();
    expect(screen.queryByText('Teammate went-private')).not.toBeInTheDocument();
    expect(screen.queryByText('Teammate mine')).not.toBeInTheDocument();
  });

  it('shows superadmins only teammates whose board policy reaches them', async () => {
    seed(
      [teammate('open', 'b-open'), teammate('private', 'b-private')],
      [board('b-open'), board('b-private')]
    );
    const client = {
      service: () => ({
        find: async ({ route }: { route: { id: string } }) => ({
          primary_owner_user_id: 'owner-1',
          board_access: {
            sharing_mode: route.id === 'b-open' ? 'shared' : 'private',
            entries: [],
          },
        }),
      }),
    } as unknown as AgorClient;
    renderDirectory({ client, currentUser: { ...member, role: 'superadmin' } as User });
    expect(await screen.findByText('Teammate open')).toBeInTheDocument();
    expect(screen.queryByText('Teammate private')).not.toBeInTheDocument();
  });

  it('searches name, purpose and owner, and reads access only for "You can ask"', async () => {
    seed(
      [teammate('alpha', 'b1'), teammate('beta', 'b2')],
      [board('b1', 'Writes specs'), board('b2')]
    );
    const find = vi.fn(async ({ route }: { route: { id: string } }) => ({
      can: route.id === 'alpha' ? 'session' : 'view',
      is_owner: false,
      source: 'others',
    }));
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    const onOpenBoard = vi.fn();
    renderDirectory({ client, checkAccess: true, onOpenBoard });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search teammates' }), {
      target: { value: 'specs' },
    });
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.queryByText('Teammate beta')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Teammate alpha, open b1' }));
    expect(onOpenBoard).toHaveBeenCalledWith('b1');
    expect(find).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search teammates' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByText('You can ask'));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.queryByText('Teammate beta')).not.toBeInTheDocument();
  });

  it('shows a loading state, not “no match”, while “You can ask” checks access', async () => {
    seed([teammate('alpha', 'b1')], [board('b1')]);
    let answer: (access: object) => void = () => {};
    const client = {
      service: () => ({
        find: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }),
    } as unknown as AgorClient;
    renderDirectory({ client, checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByRole('status', { name: 'Checking access' })).toBeInTheDocument();
    expect(screen.queryByText('No teammates match.')).not.toBeInTheDocument();
    answer({ can: 'session', is_owner: false, source: 'others' });
    expect(await screen.findByText('Teammate alpha')).toBeInTheDocument();
  });
});
