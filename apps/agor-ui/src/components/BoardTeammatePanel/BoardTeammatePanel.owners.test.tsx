import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: () => null,
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: () => <div data-testid="branch-header-pill" />,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

const branchOne = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
  created_by: 'user-creator',
} as Branch;

const branchTwo = { ...branchOne, branch_id: 'branch-2', created_by: 'user-creator' } as Branch;

const creator = { user_id: 'user-creator', name: 'creator', role: 'member' } as User;
const alice = { user_id: 'user-alice', name: 'alice', role: 'member' } as User;
const bob = { user_id: 'user-bob', name: 'bob', role: 'member' } as User;

/**
 * Feathers-shaped stub: `find` is driven per-test and `on`/`off` record the
 * listeners so a test can fire the branch-scoped realtime events the daemon
 * publishes on this route.
 */
function makeClient(find: ReturnType<typeof vi.fn>) {
  const listeners = new Map<string, Set<() => void>>();
  const service = {
    find,
    on: (event: string, handler: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
    },
    off: (event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    },
  };
  const client = { service: () => service } as unknown as AgorClient;
  const emit = (event: string) => {
    for (const handler of listeners.get(event) ?? []) handler();
  };
  const listenerCount = (event: string) => listeners.get(event)?.size ?? 0;
  return { client, emit, listenerCount };
}

function renderPanel(client: AgorClient, branch: Branch = branchOne) {
  return render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateBranch={branch}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={false}
        currentUserId="user-viewer"
        onSessionClick={vi.fn()}
        client={client}
      />
    </AntApp>
  );
}

const notFound = Object.assign(new Error('Service not found'), { code: 404 });

describe('BoardTeammatePanel branch owners badge', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([
        [creator.user_id, creator],
        [alice.user_id, alice],
        [bob.user_id, bob],
      ]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the owners returned by the owners route', async () => {
    const find = vi.fn().mockResolvedValue([alice]);
    const { client } = makeClient(find);
    renderPanel(client);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(find).toHaveBeenCalledWith({ route: { id: 'branch-1' } });
  });

  it('falls back to the branch creator when the owners table is empty', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const { client } = makeClient(find);
    renderPanel(client);

    // Matches the Settings modal, which seeds created_by as the owner for
    // branches that predate RBAC rather than showing no owner at all.
    expect(await screen.findByText('creator')).toBeInTheDocument();
  });

  it('falls back to the branch creator when RBAC is disabled', async () => {
    const find = vi.fn().mockRejectedValue(notFound);
    const { client } = makeClient(find);
    renderPanel(client);

    expect(await screen.findByText('creator')).toBeInTheDocument();
  });

  it('asserts no ownership when the owners request fails for another reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const find = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));
    const { client } = makeClient(find);
    renderPanel(client);

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('Failed to load branch owners:', expect.any(Error));
    });
    expect(screen.queryByText('creator')).not.toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });

  it('does not show the previous branch owners while the next branch resolves', async () => {
    let resolveSecond: ((owners: User[]) => void) | undefined;
    const find = vi
      .fn()
      .mockResolvedValueOnce([alice])
      .mockImplementationOnce(
        () =>
          new Promise<User[]>((resolve) => {
            resolveSecond = resolve;
          })
      );
    const { client } = makeClient(find);
    const { rerender } = renderPanel(client);

    expect(await screen.findByText('alice')).toBeInTheDocument();

    rerender(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={branchTwo}
          primaryTeammateRepo={repo}
          primaryTeammateInaccessible={false}
          currentUserId="user-viewer"
          onSessionClick={vi.fn()}
          client={client}
        />
      </AntApp>
    );

    expect(screen.queryByText('alice')).not.toBeInTheDocument();

    await act(async () => {
      resolveSecond?.([bob]);
    });
    expect(await screen.findByText('bob')).toBeInTheDocument();
  });

  it('refetches owners when the branch-scoped owners route emits', async () => {
    const find = vi.fn().mockResolvedValueOnce([alice]).mockResolvedValueOnce([bob]);
    const { client, emit } = makeClient(find);
    renderPanel(client);

    expect(await screen.findByText('alice')).toBeInTheDocument();

    await act(async () => {
      emit('created');
    });

    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('removes its realtime listeners on unmount', async () => {
    const find = vi.fn().mockResolvedValue([alice]);
    const { client, listenerCount } = makeClient(find);
    const { unmount } = renderPanel(client);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(listenerCount('created')).toBe(1);
    expect(listenerCount('removed')).toBe(1);

    unmount();

    expect(listenerCount('created')).toBe(0);
    expect(listenerCount('removed')).toBe(0);
  });

  it('resolves a late-hydrating creator without a second owners request', async () => {
    agorStore.setState({ ...EMPTY_MAPS, userById: new Map() });
    const find = vi.fn().mockResolvedValue([]);
    const { client } = makeClient(find);
    renderPanel(client);

    await waitFor(() => {
      expect(find).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('creator')).not.toBeInTheDocument();

    act(() => {
      agorStore.setState({ userById: new Map([[creator.user_id, creator]]) });
    });

    expect(await screen.findByText('creator')).toBeInTheDocument();
    expect(find).toHaveBeenCalledTimes(1);
  });
});
