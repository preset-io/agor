/**
 * Resolve the local filesystem-sandbox mounts for a short-lived branch command.
 *
 * Callers must invoke this while their trusted tenant database scope is active
 * and must pass the authenticated execution actor, not the branch or Session
 * owner. The returned paths are daemon-derived payload fields consumed only by
 * the local bubblewrap launch path; delegated launchers receive identity and
 * filesystem access through template variables instead.
 */

import type { AgorConfig } from '@agor/core/config';
import { RepoRepository, type TenantScopeAwareDatabase, UsersRepository } from '@agor/core/db';
import type { Branch, DeepReadonly, UserID } from '@agor/core/types';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from './sandbox-context.js';

export interface BranchExecutorSandboxMounts {
  sandboxHomeStore?: string;
  sandboxWorktreesRoot?: string;
  sandboxBaseRepoPath?: string;
}

export async function resolveBranchExecutorSandboxMounts(params: {
  config: DeepReadonly<AgorConfig>;
  tenantId: string;
  executionUserId: UserID;
  branch: Pick<Branch, 'repo_id' | 'storage_mode'>;
  db: TenantScopeAwareDatabase;
}): Promise<BranchExecutorSandboxMounts> {
  const { config, tenantId, executionUserId, branch, db } = params;
  const sandbox = config.execution?.sandbox;
  if (sandbox?.enabled !== true) return {};

  const mounts: BranchExecutorSandboxMounts = {
    sandboxWorktreesRoot: resolveSandboxStoragePaths(config, tenantId).worktreesRoot,
  };

  // A linked worktree's .git file points into the base repository. Clone-mode
  // branches carry their own .git and must not receive this additional mount.
  if (branch.storage_mode !== 'clone' && branch.repo_id) {
    mounts.sandboxBaseRepoPath =
      (await new RepoRepository(db).findById(branch.repo_id))?.local_path ?? undefined;
  }

  if (sandbox.home_mode === 'per_user') {
    const user = await new UsersRepository(db).findById(executionUserId);
    if (!user) {
      throw new Error(
        `Cannot resolve per-user sandbox home: execution user ${executionUserId} was not found`
      );
    }
    mounts.sandboxHomeStore = resolveOwnerHomeStore({
      config,
      tenantId,
      ownerUserId: executionUserId,
      filesystemHome: user.filesystem_home,
    });
  }

  return mounts;
}
