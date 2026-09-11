import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BranchWorkspaceCoordinator } from './coordinator';
import { WorkspaceError } from './types';

/** Delete captured generations only: a late eviction cannot delete a replacement's new epoch. */
export async function evictLocalWorkspace(c: BranchWorkspaceCoordinator): Promise<void> {
  const list = async (name: string) => {
    try {
      return await readdir(path.join(c.directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const [bases, replicas] = await Promise.all([list('base'), list('replicas')]);
  const token = randomUUID();
  await c.metadata.mutate((s, now) => {
    if (!s || s.scope.tenantId !== c.scope.tenantId || s.scope.branchId !== c.scope.branchId)
      throw new WorkspaceError('INVALID', 'Workspace not found');
    if (s.host !== null || s.leaseUntil > now || s.checkpoint?.revision !== s.revision)
      throw new WorkspaceError('BUSY', 'Eviction requires a drained checkpoint');
    s.epoch++;
    s.host = c.options.host;
    s.leaseUntil = now + c.options.leaseMs;
    s.maintenance = token;
    s.retiredExecutors ??= {};
    for (const executor of replicas) s.retiredExecutors[executor] = true;
    return { state: s, result: undefined };
  });
  try {
    // Never remove the branch/replica/base parent directories: new epochs may use them.
    for (const base of bases)
      await rm(path.join(c.directory, 'base', base), { recursive: true, force: true });
    for (const executor of replicas)
      await rm(path.dirname(c.replicaPath(executor)), { recursive: true, force: true });
  } finally {
    await c.metadata.mutate((s) => {
      if (!s || s.scope.tenantId !== c.scope.tenantId || s.scope.branchId !== c.scope.branchId)
        throw new WorkspaceError('INVALID', 'Workspace not found');
      if (s.maintenance === token) {
        delete s.maintenance;
        s.host = null;
        s.leaseUntil = 0;
      }
      return { state: s, result: undefined };
    });
  }
}
