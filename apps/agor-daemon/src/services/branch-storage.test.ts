import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  BranchStorageRepository,
  createTenantScopedDatabaseProxy,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchBundleReceipt, TenantID } from '@agor/core/types';
import { afterEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { BranchStorageService } from './branch-storage.js';

const { request, activity } = vi.hoisted(() => ({
  request: vi.fn(),
  activity: vi.fn(() => false),
}));
vi.mock('../utils/spawn-executor.js', () => ({
  requestExecutor: request,
  getDaemonUrl: () => 'https://fixture.invalid',
}));
vi.mock('../utils/upload-staging.js', () => ({ getBranchBundleStore: () => ({}) }));
vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: async () => undefined,
}));
vi.mock('../utils/branch-executor-sandbox.js', () => ({
  resolveBranchExecutorSandboxMounts: async () => ({}),
}));
vi.mock('./session-token-service.js', () => ({
  issueExecutorCommandToken: async () => 'fixture-token',
}));
vi.mock('@agor/core/analytics', () => ({ analyticsLogger: { track: vi.fn() } }));
afterEach(() => {
  vi.clearAllMocks();
  activity.mockReturnValue(false);
});
const receipt: BranchBundleReceipt = {
  bucket: 'fixture',
  key: 'fixture',
  etag: 'etag',
  providerChecksum: 'provider',
  sha256: 'a'.repeat(64),
  bytes: 10,
};
const app = { service: () => ({ emit: vi.fn() }) } as unknown as Application;

async function setup(db: Parameters<typeof seedEnvironmentCommandBranch>[0], enabled = true) {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  await new BranchRepository(db).update(branch.branch_id, { storage_mode: 'clone' });
  const params = {
    user: { user_id: user.user_id, email: user.email, role: 'member' },
    tenant: { tenant_id: 'fixture-tenant' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
  const service = new BranchStorageService(
    app,
    createTenantScopedDatabaseProxy(db),
    { execution: { branch_storage: { cold_storage_enabled: enabled } } } as AgorConfig,
    { hasBranchActivity: activity } as never
  );
  const storage = new BranchStorageRepository(db);
  request.mockImplementation(async (payload) => {
    if (payload.params.action === 'cleanup')
      expect(await storage.get(branch.branch_id)).toMatchObject({ phase: 'cleanup', receipt });
    return { success: true, data: { receipt } };
  });
  return { branch, params, service, storage };
}

dbTest(
  'persists receipt before executor cleanup and joins concurrent restores with flag disabled',
  async ({ db }) => {
    const { branch, params, service, storage } = await setup(db);
    await service.create(branch.branch_id, 'cool', params);
    expect((await storage.get(branch.branch_id)).residency).toBe('cold');
    request.mockClear();
    const disabled = new BranchStorageService(
      app,
      createTenantScopedDatabaseProxy(db),
      { execution: {} } as AgorConfig,
      null
    );
    await Promise.all(Array.from({ length: 5 }, () => disabled.restore(branch.branch_id, params)));
    expect(request.mock.calls.map(([p]) => p.params.action)).toEqual(['restore', 'publish']);
    expect((await storage.get(branch.branch_id)).residency).toBe('warm');
  }
);

dbTest(
  'default-off, terminal activity and unauthorized actors fail before admission or execution',
  async ({ db }) => {
    const { branch, params, service, storage } = await setup(db, false);
    await expect(service.create(branch.branch_id, 'cool', params)).rejects.toThrow('disabled');
    const enabled = new BranchStorageService(
      app,
      createTenantScopedDatabaseProxy(db),
      { execution: { branch_storage: { cold_storage_enabled: true } } } as AgorConfig,
      { hasBranchActivity: activity } as never
    );
    activity.mockReturnValue(true);
    await expect(enabled.create(branch.branch_id, 'cool', params)).rejects.toThrow('terminal');
    activity.mockImplementationOnce(() => {
      throw new Error('Activity check unavailable');
    });
    await expect(enabled.create(branch.branch_id, 'cool', params)).rejects.toThrow('unavailable');
    const stranger = await new UsersRepository(db).create({
      email: 'stranger@example.invalid',
      name: 'Stranger',
    });
    await expect(
      enabled.create(branch.branch_id, 'cool', {
        ...params,
        user: { ...params.user!, user_id: stranger.user_id },
      })
    ).rejects.toThrow('prompting permission');
    await expect(
      enabled.restore(branch.branch_id, { ...params, tenant: undefined })
    ).rejects.toThrow('Authentication');
    expect(request).not.toHaveBeenCalled();
    expect((await storage.get(branch.branch_id)).residency).toBe('warm');
  }
);

dbTest(
  'invalid pack receipt never admits cleanup; settled partial cleanup can restore from its receipt',
  async ({ db }) => {
    const { branch, params, service, storage } = await setup(db);
    request.mockResolvedValueOnce({ success: true, data: {} });
    await expect(service.create(branch.branch_id, 'cool', params)).rejects.toThrow('receipt');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await storage.get(branch.branch_id)).residency).toBe('warm');
    request.mockImplementation(async (payload) =>
      payload.params.action === 'cleanup'
        ? { success: false, error: { code: 'BRANCH_STORAGE_FAILED', message: 'Partial cleanup' } }
        : { success: true, data: { receipt } }
    );
    await expect(service.create(branch.branch_id, 'cool', params)).rejects.toThrow(
      'Partial cleanup'
    );
    expect(await storage.get(branch.branch_id)).toMatchObject({
      residency: 'cooling',
      retryable: true,
      receipt,
    });
    await service.restore(branch.branch_id, params);
    expect((await storage.get(branch.branch_id)).residency).toBe('warm');
    expect(
      request.mock.calls.find(([p]) => p.params.action === 'restore')?.[0].params.replacePartial
    ).toBe(true);
  }
);

dbTest(
  'unknown executor outcome stays unavailable across a new service instance; no duplicate restore',
  async ({ db }) => {
    const { branch, params, service, storage } = await setup(db);
    await service.create(branch.branch_id, 'cool', params);
    request.mockResolvedValueOnce({
      success: false,
      error: { code: 'EXECUTOR_TIMEOUT', message: 'Uncertain worker' },
    });
    await expect(service.restore(branch.branch_id, params)).rejects.toThrow('Uncertain worker');
    expect(await storage.get(branch.branch_id)).toMatchObject({
      residency: 'warming',
      retryable: false,
      receipt,
    });
    request.mockClear();
    await expect(
      new BranchStorageService(
        app,
        createTenantScopedDatabaseProxy(db),
        {} as AgorConfig,
        null
      ).restore(branch.branch_id, params)
    ).rejects.toThrow('already restoring');
    expect(request).not.toHaveBeenCalled();
    await expect(storage.admitFilesystem(branch.branch_id)).rejects.toThrow('Restore');
    await expect(new BranchRepository(db).delete(branch.branch_id)).rejects.toThrow('Restore');
  }
);

dbTest(
  'storage follows branch prompting capability even when interactive filesystem access is read-only',
  async ({ db }) => {
    const { branch, params, service, storage } = await setup(db);
    const collaborator = await new UsersRepository(db).create({
      email: 'reader@example.invalid',
      name: 'Reader',
    });
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      collaborator.user_id,
      'collaborator',
      'read',
      params.user!.user_id as never
    );
    await service.create(branch.branch_id, 'cool', {
      ...params,
      user: { ...params.user!, user_id: collaborator.user_id },
    });
    expect((await storage.get(branch.branch_id)).residency).toBe('cold');
  }
);
