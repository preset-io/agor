import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { DelegatedBranchWorkspaceStorage } from '@agor/core/types';
import { resolveManagedBranchDeletionPath } from '@agor/git';

/** Cloud's checkout operations need the tenant worktrees/repos mounts, not the
 * branch-home mount required by permanent deletion. Never accept image-local
 * empty directories as evidence that tenant storage was cleaned or removed.
 */
export async function verifyDelegatedWorkspaceStorage(
  storage: DelegatedBranchWorkspaceStorage
): Promise<void> {
  const { tenantDataRoot, branchesRoot, branchPath, repoPath } = storage;
  for (const path of [tenantDataRoot, branchesRoot, branchPath, repoPath]) {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error('Delegated workspace storage paths must be canonical');
  }
  if (storage.storageMode !== 'clone' || branchesRoot !== join(tenantDataRoot, 'worktrees'))
    throw new Error('Delegated workspace storage identity mismatch');
  const reposRoot = join(tenantDataRoot, 'repos');
  const roots = [tenantDataRoot, branchesRoot, reposRoot];
  const canonical = await Promise.all(roots.map((root) => realpath(root)));
  if (roots.some((root, index) => root !== canonical[index]))
    throw new Error('Delegated workspace storage roots must not be symlinks');
  const [tenant, worktrees, repos] = await Promise.all(roots.map((root) => stat(root)));
  if (
    !tenant.isDirectory() ||
    !worktrees.isDirectory() ||
    !repos.isDirectory() ||
    worktrees.dev === tenant.dev ||
    repos.dev !== worktrees.dev
  )
    throw new Error('Delegated workspace storage mounts are unavailable or inconsistent');

  // The shared path owner rejects root deletion, foreign-tenant targets and
  // symlinked descendants (even links to a neighboring branch in this tenant).
  await resolveManagedBranchDeletionPath(branchPath, branchesRoot);
  await resolveManagedBranchDeletionPath(repoPath, reposRoot);
  try {
    if ((await stat(branchPath)).dev !== worktrees.dev)
      throw new Error('Delegated checkout is on an unexpected storage mount');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // An absent checkout is valid for removal only after its mount was verified.
    // Cleanup separately requires an existing checkout and .git directory.
  }
}
