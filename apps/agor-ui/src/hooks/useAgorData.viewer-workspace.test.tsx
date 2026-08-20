/**
 * Viewer workspace bootstrap integration.
 *
 * The Marketplace link is only useful if the real workspace bootstrap reaches
 * AppHeader. This mounts useAgorData in front of the actual header while the
 * daemon seam enforces the MEMBER floor on users.findAll and board-objects;
 * a direct AppHeader render would miss the full-screen failure this guards.
 */

import type { AgorClient, User } from '@agor-live/client';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../components/AppHeader';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { agorStore } from '../store/agorStore';
import { useAgorData } from './useAgorData';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));
vi.mock('../components/BoardSwitcher', () => ({ BoardSwitcher: () => null }));
vi.mock('../components/BrandLogo', () => ({ BrandLogo: () => null }));
vi.mock('../components/BrandMark', () => ({ BrandMark: () => null }));
vi.mock('../components/ConnectionStatus', () => ({ ConnectionStatus: () => null }));
vi.mock('../components/GlobalUserMenu', () => ({ GlobalUserMenu: () => null }));
vi.mock('../components/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('../components/AppHeader/AppHeaderGlobalSearch', () => ({
  AppHeaderGlobalSearch: () => null,
}));
vi.mock('../components/AppHeader/GlobalPresenceFacepile', () => ({
  GlobalPresenceFacepile: () => null,
}));

type FailurePath = 'users' | 'board-objects' | 'boards';

function makeWorkspaceClient(failurePaths: FailurePath | FailurePath[] | null) {
  const failures = new Set(failurePaths ? [failurePaths].flat() : []);
  const usersFindAll = vi.fn(async () => {
    if (failures.has('users')) throw new Error('Forbidden: member role required');
    return [];
  });
  const boardObjectsFindAll = vi.fn(async () => {
    if (failures.has('board-objects')) {
      throw new Error('You need member access to manage board objects');
    }
    return [];
  });
  const services = new Map<string, Record<string, unknown>>();
  const service = (path: string) => {
    const existing = services.get(path);
    if (existing) return existing;
    const value = {
      findAll:
        path === 'users'
          ? usersFindAll
          : path === 'board-objects'
            ? boardObjectsFindAll
            : vi.fn(async () => {
                if (failures.has(path as FailurePath)) throw new Error(`Failed to load ${path}`);
                return [];
              }),
      find: vi.fn(async () => []),
      get: vi.fn(async () => null),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    services.set(path, value);
    return value;
  };
  return {
    client: {
      service,
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient,
    usersFindAll,
    boardObjectsFindAll,
  };
}

const VIEWER = {
  user_id: 'viewer-1',
  email: 'viewer@agor.live',
  name: 'Viewer',
  role: 'viewer',
} as User;

function WorkspaceBootstrap({ client, user }: { client: AgorClient; user: User }) {
  const data = useAgorData(client, {
    authenticatedUserId: user.user_id,
    authenticatedUserRole: user.role,
    authGeneration: 1,
    connectionReady: true,
  });
  if (data.loading) return <div>Loading workspace</div>;
  if (data.error) return <div role="alert">{data.error}</div>;
  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <AppHeader user={user} connected currentUserId={user.user_id} />
    </ConnectionProvider>
  );
}

function renderWorkspace(client: AgorClient, user: User) {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <WorkspaceBootstrap client={client} user={user} />
    </MemoryRouter>
  );
}

describe('viewer-safe workspace bootstrap', () => {
  it('reaches the real workspace header and Marketplace without member-only bootstrap calls', async () => {
    const { client, usersFindAll, boardObjectsFindAll } = makeWorkspaceClient([
      'users',
      'board-objects',
    ]);

    renderWorkspace(client, VIEWER);

    expect(await screen.findByRole('link', { name: 'Marketplace' })).toHaveAttribute(
      'href',
      '/ui/marketplace'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(usersFindAll).not.toHaveBeenCalled();
    expect(boardObjectsFindAll).not.toHaveBeenCalled();
  });

  it('keeps the Users directory essential for members', async () => {
    const { client, usersFindAll } = makeWorkspaceClient('users');

    renderWorkspace(client, { ...VIEWER, user_id: 'member-1', role: 'member' } as User);

    expect(await screen.findByRole('alert')).toHaveTextContent('member role required');
    expect(usersFindAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Marketplace' })).not.toBeInTheDocument();
  });

  it('keeps the privileged directory bootstrap for admins', async () => {
    const { client, usersFindAll } = makeWorkspaceClient(null);

    renderWorkspace(client, { ...VIEWER, user_id: 'admin-1', role: 'admin' } as User);

    expect(await screen.findByRole('link', { name: 'Marketplace' })).toBeInTheDocument();
    expect(usersFindAll).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade genuine essential failures for viewers', async () => {
    const { client } = makeWorkspaceClient('boards');

    renderWorkspace(client, VIEWER);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boards'));
    expect(screen.queryByRole('link', { name: 'Marketplace' })).not.toBeInTheDocument();
  });
});

function transitionClient() {
  const usersAnswers: Array<Promise<unknown[]>> = [];
  const boardObjectAnswers: Array<Promise<unknown[]>> = [];
  const ioListeners = new Map<string, Array<() => void>>();
  const usersFindAll = vi.fn(() => usersAnswers.shift() ?? Promise.resolve([]));
  const boardObjectsFindAll = vi.fn(() => boardObjectAnswers.shift() ?? Promise.resolve([]));
  const services = new Map<string, Record<string, unknown>>();
  const service = (path: string) => {
    const existing = services.get(path);
    if (existing) return existing;
    const value = {
      findAll:
        path === 'users'
          ? usersFindAll
          : path === 'board-objects'
            ? boardObjectsFindAll
            : vi.fn(async () => []),
      find: vi.fn(async () => []),
      get: vi.fn(async () => null),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    services.set(path, value);
    return value;
  };
  return {
    client: {
      service,
      io: {
        on: vi.fn((event: string, listener: () => void) =>
          ioListeners.set(event, [...(ioListeners.get(event) ?? []), listener])
        ),
        off: vi.fn((event: string, listener: () => void) =>
          ioListeners.set(
            event,
            (ioListeners.get(event) ?? []).filter((candidate) => candidate !== listener)
          )
        ),
      },
    } as unknown as AgorClient,
    usersFindAll,
    boardObjectsFindAll,
    queueUsers: (answer: Promise<unknown[]>) => usersAnswers.push(answer),
    queueBoardObjects: (answer: Promise<unknown[]>) => boardObjectAnswers.push(answer),
    emitConnect: () => {
      for (const listener of ioListeners.get('connect') ?? []) listener();
    },
  };
}

function deferredList() {
  let resolve!: (value: unknown[]) => void;
  const promise = new Promise<unknown[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace authority generation ordering', () => {
  it('discards delayed member responses after demotion', async () => {
    const seam = transitionClient();
    const objects = deferredList();
    seam.queueUsers(Promise.resolve([{ ...VIEWER, user_id: 'same-user', role: 'member' }]));
    seam.queueBoardObjects(objects.promise);
    const { result, rerender } = renderHook(
      ({ role, ready, generation }: { role: string; ready: boolean; generation: number }) =>
        useAgorData(seam.client, {
          authenticatedUserId: 'same-user',
          authenticatedUserRole: role,
          authGeneration: generation,
          connectionReady: ready,
        }),
      { initialProps: { role: 'member', ready: true, generation: 1 } }
    );
    await waitFor(() => expect(seam.boardObjectsFindAll).toHaveBeenCalledTimes(1));

    // The role can render before useAgorClient publishes its reauthenticated
    // generation. Even with a still-true connection bit, the old member fetch
    // is invalid and no viewer-era resync may start.
    rerender({ role: 'viewer', ready: true, generation: 1 });
    await act(async () => {
      objects.resolve([{ object_id: 'old-object', board_id: 'board-1' }]);
      await objects.promise;
    });
    expect(agorStore.getState().userById.size).toBe(0);
    expect(agorStore.getState().boardObjectById.size).toBe(0);

    rerender({ role: 'viewer', ready: true, generation: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(agorStore.getState().userById.size).toBe(0);
    expect(agorStore.getState().boardObjectById.size).toBe(0);
  });

  it('waits for member socket reauthentication before promotion resync', async () => {
    const seam = transitionClient();
    const promoted = { ...VIEWER, user_id: 'same-user', role: 'member' };
    seam.queueUsers(Promise.resolve([promoted]));
    seam.queueBoardObjects(Promise.resolve([{ object_id: 'member-object', board_id: 'board-1' }]));
    const { result, rerender } = renderHook(
      ({ role, ready, generation }: { role: string; ready: boolean; generation: number }) =>
        useAgorData(seam.client, {
          authenticatedUserId: 'same-user',
          authenticatedUserRole: role,
          authGeneration: generation,
          connectionReady: ready,
        }),
      { initialProps: { role: 'viewer', ready: true, generation: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(seam.usersFindAll).not.toHaveBeenCalled();

    // Adversarial ordering: fresh identity renders before the connection hook
    // has closed its gate. The unchanged auth generation must still withhold.
    rerender({ role: 'member', ready: true, generation: 1 });
    await act(async () => Promise.resolve());
    expect(seam.usersFindAll).not.toHaveBeenCalled();

    rerender({ role: 'member', ready: false, generation: 1 });
    expect(seam.usersFindAll).not.toHaveBeenCalled();

    rerender({ role: 'member', ready: true, generation: 2 });
    await waitFor(() => expect(seam.usersFindAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(agorStore.getState().userById.get('same-user')).toBeDefined());
    expect(agorStore.getState().boardObjectById.has('member-object')).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('ignores reconnect delivery until the new authenticated generation is ready', async () => {
    const seam = transitionClient();
    seam.queueUsers(Promise.resolve([]));
    seam.queueBoardObjects(Promise.resolve([]));
    const { result, rerender } = renderHook(
      ({ ready, generation }: { ready: boolean; generation: number }) =>
        useAgorData(seam.client, {
          authenticatedUserId: 'member-user',
          authenticatedUserRole: 'member',
          authGeneration: generation,
          connectionReady: ready,
        }),
      { initialProps: { ready: true, generation: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(seam.usersFindAll).toHaveBeenCalledTimes(1);

    rerender({ ready: false, generation: 1 });
    act(() => seam.emitConnect());
    await act(async () => Promise.resolve());
    expect(seam.usersFindAll).toHaveBeenCalledTimes(1);

    seam.queueUsers(Promise.resolve([]));
    seam.queueBoardObjects(Promise.resolve([]));
    rerender({ ready: true, generation: 2 });
    await waitFor(() => expect(seam.usersFindAll).toHaveBeenCalledTimes(2));
    expect(result.current.error).toBeNull();
  });
});
