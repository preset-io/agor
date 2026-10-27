/**
 * Revalidate a persisted branch path before it reaches any filesystem or
 * executor sink. Stored rows are not trusted: the path must resolve below the
 * caller tenant's branches root without traversing a symlink, so a historical,
 * tampered or symlink-planted location fails closed.
 */

import { isAbsolute, join, relative } from 'node:path';
import { getAgorHome, getBranchesDir, isManagedBranchPath } from '@agor/core/config';
import { canonicalizeProspectivePath } from './sandbox-context.js';

export function assertManagedBranchPath(branchPath: unknown, tenantId?: string): string {
  managedBranchesRoot(branchPath, tenantId);
  return branchPath as string;
}

/**
 * The root spelling a valid branch path lives under: the tenant branches root,
 * or the legacy `<agor home>/worktrees` alias. Executor walks need this root,
 * not the current one, to accept the same rows the daemon accepts.
 */
export function managedBranchesRoot(branchPath: unknown, tenantId?: string): string {
  if (typeof branchPath !== 'string' || !isAbsolute(branchPath)) throw outsideRoot();
  const root = getBranchesDir(tenantId);
  const canonicalRoot = canonicalizeProspectivePath(root);
  // Documented storage migrations move worktrees to a new data home and keep
  // the old location as a symlink, so historical rows may name the alias. Only
  // that daemon-owned location may be the symlink; nothing below it may.
  const legacyRoot = join(getAgorHome(), 'worktrees');
  for (const candidate of [root, legacyRoot]) {
    if (!isManagedBranchPath(branchPath, candidate)) continue;
    if (candidate !== root && canonicalizeProspectivePath(candidate) !== canonicalRoot) continue;
    if (
      canonicalizeProspectivePath(branchPath) !==
      join(canonicalRoot, relative(candidate, branchPath))
    ) {
      throw new Error('Branch workspace path traverses a symlink');
    }
    return candidate;
  }
  throw outsideRoot();
}

/**
 * Root for executor removal walks. Invalid rows keep the current root so the
 * executor's own no-symlink walk still refuses them.
 */
export function removalBranchesRoot(branchPath: unknown, tenantId?: string): string {
  try {
    return managedBranchesRoot(branchPath, tenantId);
  } catch {
    return getBranchesDir(tenantId);
  }
}

function outsideRoot(): Error {
  return new Error("Branch workspace path is outside this tenant's managed branch directory");
}
