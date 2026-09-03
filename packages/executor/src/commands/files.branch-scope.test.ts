import { describe, expect, it, vi } from 'vitest';
import type { BranchFilesystemStatusPayload } from '../payload-types.js';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  lstat: mocks.lstat,
}));

import { handleBranchFilesystemStatus } from './files.js';

const BRANCH_A = '00000000-0000-7000-8000-00000000000a';
const BRANCH_B = '00000000-0000-7000-8000-00000000000b';

describe('branch filesystem status executor boundary', () => {
  it('does not perform Branch B repository lookup or filesystem probing after service authorization denies it', async () => {
    const repositoryLookup = vi.fn();
    const branchGet = vi.fn(async (branchId: string) => {
      if (branchId !== BRANCH_A) {
        throw new Error('Executor runtime scope is not authorized to read this Branch');
      }
      repositoryLookup(branchId);
      return { branch_id: BRANCH_A, path: '/fixture/branch-a' };
    });
    const disconnect = vi.fn();
    mocks.createExecutorClient.mockResolvedValueOnce({
      io: { disconnect },
      service(name: string) {
        expect(name).toBe('branches');
        return { get: branchGet };
      },
    });

    const payload = {
      command: 'branch.filesystem.status',
      sessionToken: 'executor-token-a',
      daemonUrl: 'http://daemon.test',
      params: { branchIds: [BRANCH_B] },
    } satisfies BranchFilesystemStatusPayload;

    await expect(handleBranchFilesystemStatus(payload, {})).resolves.toEqual({
      success: false,
      error: {
        code: 'BRANCH_FILESYSTEM_STATUS_FAILED',
        message: 'Executor runtime scope is not authorized to read this Branch',
      },
    });
    expect(mocks.createExecutorClient).toHaveBeenCalledWith(
      'http://daemon.test',
      'executor-token-a'
    );
    expect(branchGet).toHaveBeenCalledWith(BRANCH_B);
    expect(repositoryLookup).not.toHaveBeenCalled();
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
