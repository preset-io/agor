import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { TeammatesDirectory } from './TeammatesDirectory';

const ME = 'user-me';
const member = { user_id: ME, name: 'Kasia', role: 'member' } as User;
const superadmin = { ...member, role: 'superadmin' } as User;

const teammate = (id: string, boardId: string, owner = 'owner-1') =>
  ({
    branch_id: id,
    name: id,
    board_id: boardId,
    created_by: owner,
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: `Teammate ${id}` } },
  }) as unknown as Branch;
const board = (id: string, description?: string, name = id) =>
  ({ board_id: id, name, archived: false, description }) as Board;

function seed(branches: Branch[], boards: Board[], { hydrated = true } = {}) {
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    boardById: new Map(boards.map((b) => [b.board_id, b])),
    userById: new Map([['owner-1', { user_id: 'owner-1', name: 'Zoë Owner' } as User]]),
    branchesHydrated: hydrated,
  } as never);
}

type Find = (args: { route: { id: string } }) => Promise<unknown>;

/** Effective-access reads go to `find`; the caller belongs to group `crew`. */
const clientWith = (find: Find, boardPolicy?: Find) =>
  ({
    service: (name: string) => {
      if (name === 'boards/:id/permissions') return { find: boardPolicy };
      if (name === 'group-memberships')
        return { findAll: async () => [{ group_id: 'crew', user_id: ME }] };
      if (name === 'groups') return { findAll: async () => [{ group_id: 'crew' }] };
      return { find };
    },
  }) as unknown as AgorClient;

const answer = (can: 'session' | 'view') => ({ can, is_owner: false, source: 'others' });

/** A board policy every member can view. */
const openPolicy = () => ({
  primary_owner_user_id: 'owner-1',
  board_access: {
    schema_version: 1,
    policy_kind: 'board_access',
    sharing_mode: 'shared',
    entries: [],
    others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
  },
});

/** Access reads that resolve only when the test says so. */
function deferredReads() {
  const waiting = new Map<string, (value: unknown) => void>();
  const find = vi.fn(
    ({ route }: { route: { id: string } }) =>
      new Promise((resolve) => waiting.set(route.id, resolve))
  );
  const resolve = (id: string, value: unknown) => {
    waiting.get(id)?.(value);
    waiting.delete(id);
  };
  return { find, resolve, waiting };
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

const search = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Search teammates' }), {
    target: { value },
  });

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

  it('shows superadmins only teammates whose board policy reaches them, groups included', async () => {
    seed(
      [teammate('open', 'b-open'), teammate('crew', 'b-crew'), teammate('private', 'b-private')],
      [board('b-open'), board('b-crew'), board('b-private')]
    );
    const entry = (principal: object) => ({
      entry_id: 'e',
      principal,
      preset: 'viewer',
      capabilities: ['board.view'],
      fs_access: 'none',
    });
    const policy = (id: string) => ({
      schema_version: 1,
      policy_kind: 'board_access',
      sharing_mode: id === 'b-private' ? 'private' : 'shared',
      entries: id === 'b-crew' ? [entry({ principal_type: 'group', group_id: 'crew' })] : [],
      others:
        id === 'b-open'
          ? { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' }
          : { preset: 'none', capabilities: [], fs_access: 'none' },
    });
    const client = clientWith(vi.fn(), async ({ route }) => ({
      primary_owner_user_id: 'owner-1',
      board_access: policy(route.id),
    }));
    renderDirectory({ client, currentUser: superadmin });
    expect(await screen.findByText('Teammate open')).toBeInTheDocument();
    expect(await screen.findByText('Teammate crew')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading teammates' })).not.toBeInTheDocument()
    );
    expect(screen.queryByText(/Loading more teammates/)).not.toBeInTheDocument();
    expect(screen.queryByText('Teammate private')).not.toBeInTheDocument();
  });

  it('shows loading, not an empty state, until branches and policy reads settle', async () => {
    seed([teammate('open', 'b-open')], [board('b-open')], { hydrated: false });
    let grant: ((value: unknown) => void) | undefined;
    const client = clientWith(
      vi.fn(),
      () =>
        new Promise((resolve) => {
          grant = resolve;
        })
    );
    renderDirectory({ client, currentUser: superadmin });
    expect(screen.getByRole('status', { name: 'Loading teammates' })).toBeInTheDocument();
    expect(screen.queryByText(/No teammates/)).not.toBeInTheDocument();

    act(() => agorStore.setState({ branchesHydrated: true } as never));
    expect(screen.getByRole('status', { name: 'Loading teammates' })).toBeInTheDocument();
    await waitFor(() => expect(grant).toBeDefined());
    await act(async () =>
      grant?.({
        primary_owner_user_id: 'owner-1',
        board_access: {
          schema_version: 1,
          policy_kind: 'board_access',
          sharing_mode: 'private',
          entries: [],
          others: { preset: 'none', capabilities: [], fs_access: 'none' },
        },
      })
    );
    expect(await screen.findByText('No teammates are shared with you yet.')).toBeInTheDocument();
  });

  it('searches name, purpose, board and owner ignoring case and accents', async () => {
    seed(
      [teammate('alpha', 'b1'), teammate('beta', 'b2'), teammate('gamma', 'b3', 'owner-2')],
      [board('b1', 'Writes specs'), board('b2', undefined, 'Café launch'), board('b3')]
    );
    const find = vi.fn(async () => answer('session'));
    const onOpenBoard = vi.fn();
    renderDirectory({ client: clientWith(find), checkAccess: true, onOpenBoard });
    search('SPECS');
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.queryByText('Teammate beta')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Teammate alpha, open b1' }));
    expect(onOpenBoard).toHaveBeenCalledWith('b1');

    search('cafe');
    expect(screen.getByText('Teammate beta')).toBeInTheDocument();
    expect(screen.queryByText('Teammate alpha')).not.toBeInTheDocument();

    search('zoe');
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.queryByText('Teammate gamma')).not.toBeInTheDocument();

    search('nothing like it');
    expect(screen.getByText('No teammates match.')).toBeInTheDocument();
    expect(find).not.toHaveBeenCalled();
  });

  it('reads access only for "You can ask" and shows answers as they arrive', async () => {
    seed([teammate('alpha', 'b1'), teammate('beta', 'b2')], [board('b1'), board('b2')]);
    const reads = deferredReads();
    renderDirectory({ client: clientWith(reads.find), checkAccess: true });
    expect(reads.find).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByRole('status', { name: 'Checking access' })).toBeInTheDocument();
    expect(screen.queryByText('No teammates match.')).not.toBeInTheDocument();
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(2));

    await act(async () => reads.resolve('alpha', answer('session')));
    expect(await screen.findByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.getByText('Checking access for 1 more…')).toBeInTheDocument();

    await act(async () => reads.resolve('beta', answer('view')));
    await waitFor(() => expect(screen.queryByText(/Checking access/)).not.toBeInTheDocument());
    expect(screen.queryByText('Teammate beta')).not.toBeInTheDocument();

    // Back under "All", the answer already known marks the view-only teammate.
    fireEvent.click(screen.getByText('All'));
    expect(await screen.findByText('Teammate beta')).toBeInTheDocument();
    expect(screen.getByText(/View only · ask Zoë Owner for access/)).toBeInTheDocument();
  });

  it('says how many access checks failed and retries them', async () => {
    seed([teammate('alpha', 'b1'), teammate('beta', 'b2')], [board('b1'), board('b2')]);
    const find = vi
      .fn<Find>()
      .mockImplementation(async ({ route }) =>
        route.id === 'beta' ? Promise.reject(new Error('offline')) : answer('session')
      );
    renderDirectory({ client: clientWith(find), checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText(/Couldn’t check access for 1 teammate/)).toBeInTheDocument();
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();

    find.mockImplementation(async () => answer('session'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Teammate beta')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t check access/)).not.toBeInTheDocument();
  });

  it('shows no empty state when every access check failed, only the retry notice', async () => {
    seed([teammate('alpha', 'b1'), teammate('beta', 'b2')], [board('b1'), board('b2')]);
    renderDirectory({
      client: clientWith(async () => Promise.reject(new Error('offline'))),
      checkAccess: true,
    });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText(/Couldn’t check access for 2 teammates/)).toBeInTheDocument();
    expect(screen.queryByText(/No teammates|None you can ask/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Checking access' })).not.toBeInTheDocument();
  });

  it('counts only pending checks that match the search', async () => {
    seed(
      [teammate('alpha', 'b1'), teammate('beta', 'b2'), teammate('gamma', 'b3')],
      [board('b1', 'Writes specs'), board('b2', 'Writes specs'), board('b3', 'Ships builds')]
    );
    const reads = deferredReads();
    renderDirectory({ client: clientWith(reads.find), checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(3));
    await act(async () => reads.resolve('alpha', answer('session')));
    expect(await screen.findByText('Checking access for 2 more…')).toBeInTheDocument();

    search('specs');
    expect(screen.getByText('Checking access for 1 more…')).toBeInTheDocument();
    // Free the shared read slots for the next test.
    await act(async () => {
      for (const id of [...reads.waiting.keys()]) reads.resolve(id, answer('view'));
    });
  });

  it('counts only failed checks that match the search', async () => {
    seed(
      [teammate('alpha', 'b1'), teammate('beta', 'b2'), teammate('gamma', 'b3')],
      [board('b1', 'Writes specs'), board('b2', 'Writes specs'), board('b3', 'Ships builds')]
    );
    renderDirectory({
      client: clientWith(async () => Promise.reject(new Error('offline'))),
      checkAccess: true,
    });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText(/Couldn’t check access for 3 teammates/)).toBeInTheDocument();

    search('specs');
    expect(screen.getByText(/Couldn’t check access for 2 teammates/)).toBeInTheDocument();
    search('builds');
    expect(screen.getByText(/Couldn’t check access for 1 teammate /)).toBeInTheDocument();
  });

  it('reads a superadmin’s policies in list order, so the first card needn’t wait', async () => {
    // Board ids sort opposite to the list, and only four reads run at once.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    seed(
      ids.map((id, i) => teammate(id, `b-${5 - i}`)),
      ids.map((_, i) => board(`b-${5 - i}`))
    );
    const reads = deferredReads();
    renderDirectory({ client: clientWith(vi.fn(), reads.find), currentUser: superadmin });
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(4));

    await act(async () => reads.resolve('b-5', openPolicy()));
    expect(await screen.findByText('Teammate a')).toBeInTheDocument();
    expect(screen.queryByText('Teammate b')).not.toBeInTheDocument();
    // Free the shared read slots for the next test.
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(5));
    await act(async () => {
      for (const id of [...reads.waiting.keys()]) reads.resolve(id, openPolicy());
    });
    expect(await screen.findByText('Teammate e')).toBeInTheDocument();
  });

  it('retries only access checks when no policy read failed', async () => {
    seed([teammate('alpha', 'b1'), teammate('beta', 'b2')], [board('b1'), board('b2')]);
    const policy = vi.fn<Find>(async () => openPolicy());
    const find = vi
      .fn<Find>()
      .mockImplementation(async ({ route }) =>
        route.id === 'beta' ? Promise.reject(new Error('offline')) : answer('session')
      );
    renderDirectory({
      client: clientWith(find, policy),
      currentUser: superadmin,
      checkAccess: true,
    });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText(/Couldn’t check access for 1 teammate/)).toBeInTheDocument();
    expect(policy).toHaveBeenCalledTimes(2);

    // Past the cache's freshness, a policy re-read would reach the server.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    find.mockImplementation(async () => answer('session'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Teammate beta')).toBeInTheDocument();
    expect(policy).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('keeps list order: a late answer never lands above cards already shown', async () => {
    seed(
      [teammate('alpha', 'b1'), teammate('beta', 'b2'), teammate('gamma', 'b3')],
      [board('b1'), board('b2'), board('b3')]
    );
    const reads = deferredReads();
    renderDirectory({ client: clientWith(reads.find), checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(3));

    // Beta answers first but waits for alpha, which comes before it.
    await act(async () => reads.resolve('beta', answer('session')));
    expect(screen.queryByText('Teammate beta')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Checking access' })).toBeInTheDocument();

    await act(async () => reads.resolve('alpha', answer('session')));
    expect(await screen.findByText('Teammate alpha')).toBeInTheDocument();
    expect(screen.getByText('Teammate beta')).toBeInTheDocument();
    const names = screen.getAllByText(/^Teammate (alpha|beta)$/).map((el) => el.textContent);
    expect(names).toEqual(['Teammate alpha', 'Teammate beta']);
    expect(screen.getByText('Checking access for 1 more…')).toBeInTheDocument();
    await act(async () => reads.resolve('gamma', answer('view')));
  });

  it('drops stale failures when "You can ask" is chosen again and re-read', async () => {
    seed([teammate('alpha', 'b1')], [board('b1')]);
    const reads = deferredReads();
    const find = vi
      .fn<Find>()
      .mockImplementationOnce(async () => Promise.reject(new Error('offline')))
      .mockImplementation(reads.find);
    renderDirectory({ client: clientWith(find), checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText(/Couldn’t check access for 1 teammate/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('All'));
    fireEvent.click(screen.getByText('You can ask'));
    expect(screen.queryByText(/Couldn’t check access/)).not.toBeInTheDocument();
    expect(await screen.findByRole('status', { name: 'Checking access' })).toBeInTheDocument();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await act(async () => reads.resolve('alpha', answer('session')));
    expect(await screen.findByText('Teammate alpha')).toBeInTheDocument();
  });

  it('counts a superadmin’s failed policy read in the notice and retries it', async () => {
    seed([teammate('open', 'b-open')], [board('b-open')]);
    const policy = vi
      .fn<Find>()
      .mockImplementationOnce(async () => Promise.reject(new Error('offline')))
      .mockImplementation(async () => ({
        primary_owner_user_id: 'owner-1',
        board_access: {
          schema_version: 1,
          policy_kind: 'board_access',
          sharing_mode: 'shared',
          entries: [],
          others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
        },
      }));
    renderDirectory({ client: clientWith(vi.fn(), policy), currentUser: superadmin });
    expect(await screen.findByText(/Couldn’t check access for 1 teammate/)).toBeInTheDocument();
    // Settled: no endless loading, and no empty state the notice already explains.
    expect(screen.queryByRole('status', { name: 'Loading teammates' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No teammates/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Teammate open')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t check access/)).not.toBeInTheDocument();
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('abandons queued access reads when the viewer switches back to "All"', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    seed(
      ids.map((id) => teammate(id, `b-${id}`)),
      ids.map((id) => board(`b-${id}`))
    );
    const reads = deferredReads();
    renderDirectory({ client: clientWith(reads.find), checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    // Four reads run at once; the other two wait for a slot.
    await waitFor(() => expect(reads.find).toHaveBeenCalledTimes(4));

    fireEvent.click(screen.getByText('All'));
    await act(async () => {
      for (const id of [...reads.waiting.keys()]) reads.resolve(id, answer('session'));
    });
    await act(async () => {});
    expect(reads.find).toHaveBeenCalledTimes(4);
  });

  it('drops back to "All" when the viewer loses the "You can ask" filter', async () => {
    seed([teammate('alpha', 'b1')], [board('b1')]);
    const client = clientWith(async () => answer('view'));
    const { rerender } = renderDirectory({ client, checkAccess: true });
    fireEvent.click(screen.getByText('You can ask'));
    expect(await screen.findByText('None you can ask yet.')).toBeInTheDocument();

    rerender(
      <AntApp>
        <MemoryRouter>
          <TeammatesDirectory client={client} currentUser={member} onOpenBoard={vi.fn()} />
        </MemoryRouter>
      </AntApp>
    );
    expect(screen.queryByText('You can ask')).not.toBeInTheDocument();
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();

    rerender(
      <AntApp>
        <MemoryRouter>
          <TeammatesDirectory
            client={client}
            currentUser={member}
            checkAccess
            onOpenBoard={vi.fn()}
          />
        </MemoryRouter>
      </AntApp>
    );
    expect(screen.getByText('Teammate alpha')).toBeInTheDocument();
  });
});
