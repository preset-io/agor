import {
  BranchRepository,
  BranchStorageRepository,
  createTenantScopedDatabaseProxy,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchBundleReceipt, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { registerBranchBundleTransfers } from './branch-bundle-transfers.js';

const { upload, read } = vi.hoisted(() => ({ upload: vi.fn(), read: vi.fn() }));
vi.mock('./upload-staging.js', () => ({ getBranchBundleStore: () => ({ upload, read }) }));

dbTest(
  'byte plane requires verified exact command/branch/operation before storage access',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    await new BranchRepository(db).update(branch.branch_id, { storage_mode: 'clone' });
    const record = await new BranchStorageRepository(db).beginCooling(branch.branch_id);
    const receipt: BranchBundleReceipt = {
      bucket: 'fixture',
      key: 'fixture',
      etag: 'e',
      sha256: 'a'.repeat(64),
      bytes: 1,
      providerChecksum: 'p',
    };
    upload.mockResolvedValue(receipt);
    let handler: (...args: unknown[]) => Promise<void>;
    const app = {
      service: vi.fn(),
      post: (_path: string, fn: typeof handler) => {
        handler = fn;
      },
      get: vi.fn(),
    };
    const authenticate = vi.fn();
    registerBranchBundleTransfers({
      app: app as unknown as Application,
      db: createTenantScopedDatabaseProxy(db),
      config: {} as never,
      multiTenancy: {} as never,
      authenticate,
    });
    const claims = {
      type: 'executor-session',
      purpose: 'executor-command',
      session_id: `branch-storage:${record.operationId}:pack`,
      branch_id: branch.branch_id,
    };
    const params = {
      tenant: { tenant_id: 'fixture-tenant' as TenantID, source: 'explicit' },
      user: { user_id: user.user_id, email: user.email, role: 'member' },
      authentication: { strategy: 'jwt', payload: claims },
    } as AuthenticatedParams;
    const invoke = async (auth: AuthenticatedParams) => {
      authenticate.mockResolvedValue(auth);
      const res = {
        status: vi.fn().mockReturnThis(),
        end: vi.fn(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer fixture' },
          params: { branchId: branch.branch_id, operationId: record.operationId },
        },
        res
      );
      return res;
    };
    for (const payload of [
      {},
      { ...claims, branch_id: 'foreign' },
      { ...claims, session_id: 'branch-storage:stale:pack' },
      { ...claims, session_id: `branch-storage:${record.operationId}:restore` },
    ]) {
      const response = await invoke({ ...params, authentication: { strategy: 'jwt', payload } });
      expect(response.status).toHaveBeenCalledWith(403);
    }
    expect(upload).not.toHaveBeenCalled();
    const success = await invoke(params);
    expect(success.json).toHaveBeenCalledWith(receipt);
    expect(upload).toHaveBeenCalledTimes(1);
    // A transfer alone is not authority to delete the source.
    expect((await new BranchStorageRepository(db).get(branch.branch_id)).phase).toBe('packing');
    expect(read).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      upload.mockRejectedValueOnce(new Error('sensitive provider URL must not be logged'));
      const failure = await invoke(params);
      expect(failure.status).toHaveBeenCalledWith(502);
      expect(warn).toHaveBeenCalledWith(
        '[BranchStorage] event=bundle_transfer_failed stage=upload category=unavailable_or_unverified'
      );
      expect((await new BranchStorageRepository(db).get(branch.branch_id)).phase).toBe('packing');
    } finally {
      warn.mockRestore();
    }
  }
);
