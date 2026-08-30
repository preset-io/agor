import type { TaskID, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { invalidateLiveBranchCodexCredentialBinds } from './codex-auth-bind-invalidation';

describe('branch Codex credential-bind invalidation', () => {
  it.each([
    ['credentials_imported' as const, /binds the new auth\.json inode/],
    ['credentials_removed' as const, /pinned the prior auth\.json inode/],
  ])('durably requests every actor-scoped live task after %s', async (reason, message) => {
    const terminate = vi.fn(async () => undefined);
    await invalidateLiveBranchCodexCredentialBinds({
      app: {} as never,
      db: {} as never,
      tenantId: 'tenant-1',
      userId: 'actor-1' as UserID,
      reason,
      depsForTest: {
        loadTargets: async () => ['task-1', 'task-2'] as TaskID[],
        terminate,
      },
    });

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenNthCalledWith(1, 'task-1', expect.stringMatching(message));
    expect(terminate).toHaveBeenNthCalledWith(2, 'task-2', expect.stringMatching(message));
  });

  it('continues requesting other tasks when one termination coordinator fails', async () => {
    const terminate = vi
      .fn<(taskId: TaskID) => Promise<void>>()
      .mockRejectedValueOnce(new Error('lost race'))
      .mockResolvedValueOnce(undefined);
    await invalidateLiveBranchCodexCredentialBinds({
      app: {} as never,
      db: {} as never,
      tenantId: 'tenant-1',
      userId: 'actor-1' as UserID,
      reason: 'credentials_imported',
      depsForTest: {
        loadTargets: async () => ['task-1', 'task-2'] as TaskID[],
        terminate,
      },
    });

    expect(terminate).toHaveBeenCalledTimes(2);
  });
});
