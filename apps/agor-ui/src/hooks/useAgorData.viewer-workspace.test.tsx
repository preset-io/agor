/**
 * Viewer workspace bootstrap integration.
 *
 * The Marketplace link is only useful if the real workspace bootstrap reaches
 * AppHeader. This mounts useAgorData in front of the actual header while the
 * daemon seam enforces the MEMBER floor on users.findAll and board-objects;
 * a direct AppHeader render would miss the full-screen failure this guards.
 */

import type { AgorClient, User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../components/AppHeader';
import { ConnectionProvider } from '../contexts/ConnectionContext';
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
  const data = useAgorData(client, { authenticatedUserRole: user.role });
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
