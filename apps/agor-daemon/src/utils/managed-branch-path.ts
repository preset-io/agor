/**
 * Revalidate a persisted branch path before it reaches any filesystem or
 * executor sink. Stored rows are not trusted: the path must resolve below the
 * caller tenant's branches root without traversing a symlink, so a historical,
 * tampered or symlink-planted location fails closed.
 */

import { isAbsolute, join, relative } from 'node:path';
import { getBranchesDir, isManagedBranchPath } from '@agor/core/config';
import { canonicalizeProspectivePath } from './sandbox-context.js';

export function assertManagedBranchPath(branchPath: unknown, tenantId?: string): string {
  if (typeof branchPath !== 'string' || !isAbsolute(branchPath)) throw outsideRoot();
  const root = getBranchesDir(tenantId);
  const canonicalRoot = canonicalizeProspectivePath(root);
  const canonical = canonicalizeProspectivePath(branchPath);
  if (isManagedBranchPath(branchPath, root)) {
    // Any symlink component below the root changes the canonical path, even
    // one that targets another branch inside the same tenant.
    if (canonical !== join(canonicalRoot, relative(root, branchPath))) {
      throw new Error('Branch workspace path traverses a symlink');
    }
    return branchPath;
  }
  // Documented storage migrations keep the old root as a symlink to the new
  // one, so historical rows may name the alias. Accept only when it resolves
  // to a managed location under the current root.
  if (isManagedBranchPath(canonical, canonicalRoot) && isManagedBranchPath(branchPath, '/')) {
    return branchPath;
  }
  throw outsideRoot();
}

function outsideRoot(): Error {
  return new Error("Branch workspace path is outside this tenant's managed branch directory");
}
