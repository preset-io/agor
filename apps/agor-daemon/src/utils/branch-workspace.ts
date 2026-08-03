import { getBranchesDir } from '@agor/core/config';
import {
  RepoRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { Branch } from '@agor/core/types';
import { assertManagedBranchPath } from '@agor/core/workspace-paths';

/** Fail closed when a historical branch row reaches an execution boundary. */
export async function resolveTrustedBranchWorkspace(
  db: TenantScopedDatabase | TenantScopeAwareDatabase,
  branch: Branch,
  tenantId?: string
): Promise<string> {
  const repo = await new RepoRepository(db).findById(branch.repo_id);
  if (!repo) throw new Error(`Repository ${branch.repo_id} not found for branch workspace`);
  return assertManagedBranchPath({
    root: getBranchesDir(tenantId),
    repoSlug: repo.slug,
    branchName: branch.name,
    storedPath: branch.path,
  });
}
