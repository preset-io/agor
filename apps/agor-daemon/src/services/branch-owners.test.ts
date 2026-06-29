import { describe, expect, it, vi } from 'vitest';
import { setupBranchOwnersService } from './branch-owners';

const mocks = vi.hoisted(() => ({
  createServiceToken: vi.fn(() => 'service-token'),
  spawnExecutorFireAndForget: vi.fn(),
}));

vi.mock('../utils/spawn-executor.js', () => ({
  createServiceToken: mocks.createServiceToken,
  getDaemonUrl: () => 'http://localhost:3030',
  serviceTokenScopeForParams: (params?: { tenant?: { tenant_id?: string } }) =>
    params?.tenant?.tenant_id ? { tenant_id: params.tenant.tenant_id } : {},
  spawnExecutorFireAndForget: mocks.spawnExecutorFireAndForget,
}));

function makeApp() {
  const services = new Map<string, any>();
  services.set('users', {
    get: vi.fn(async (userId: string) => ({ user_id: userId, email: `${userId}@example.com` })),
  });

  return {
    use: vi.fn((path: string, service: any) => {
      service.hooks = vi.fn((hooks: unknown) => {
        service.registeredHooks = hooks;
      });
      services.set(path, service);
    }),
    service: vi.fn((path: string) => services.get(path)),
  };
}

const branchRepo = {
  getOwners: vi.fn(async () => []),
  addOwner: vi.fn(async () => undefined),
  removeOwner: vi.fn(async () => undefined),
  isOwner: vi.fn(async () => true),
  findById: vi.fn(async () => ({ branch_id: 'branch-1', others_can: 'all' })),
  resolveUserPermission: vi.fn(async () => 'all'),
};

describe('setupBranchOwnersService Unix sync hooks', () => {
  it('does not spawn Unix sync in RBAC-only simple mode', async () => {
    vi.clearAllMocks();
    const app = makeApp();
    setupBranchOwnersService(app as never, branchRepo as never, {
      jwtSecret: 'secret',
      unixFsIsolationEnabled: false,
    });

    const service = app.service('branches/:id/owners');
    await service.registeredHooks.after.create[0]({
      params: { route: { id: 'branch-1' } },
    });

    expect(mocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
    expect(mocks.createServiceToken).not.toHaveBeenCalled();
  });

  it('spawns tenant-scoped Unix sync when filesystem isolation is enabled', async () => {
    vi.clearAllMocks();
    const app = makeApp();
    setupBranchOwnersService(app as never, branchRepo as never, {
      jwtSecret: 'secret',
      unixFsIsolationEnabled: true,
      daemonUser: 'agor',
    });

    const service = app.service('branches/:id/owners');
    await service.registeredHooks.after.create[0]({
      params: {
        route: { id: 'branch-1' },
        tenant: { tenant_id: 'tenant-a' },
      },
    });

    expect(mocks.createServiceToken).toHaveBeenCalledWith('secret', undefined, {
      tenant_id: 'tenant-a',
      branch_id: 'branch-1',
      command: 'unix.sync-branch',
    });
    expect(mocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'unix.sync-branch',
        sessionToken: 'service-token',
        params: expect.objectContaining({ branchId: 'branch-1', daemonUser: 'agor' }),
      }),
      { logPrefix: '[Executor/branch-owners.create]' }
    );
  });
});
