import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, UUID } from '@agor/core/types';
import { hasBranchPermission } from '../../utils/branch-authorization.js';
import type { AuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';

type ConfigurationQuery = { branch_id?: unknown };

/** Resolves the only caller-controlled OpenCode discovery scope after tenant and branch checks. */
export async function resolveOpenCodeConfigurationDirectory(input: {
  db: TenantScopeAwareDatabase;
  context: AuthenticatedOpenCodeSubjectContext;
  config: AgorConfig;
  params?: AuthenticatedParams & { query?: ConfigurationQuery };
}): Promise<string | undefined> {
  const query = input.params?.query;
  const unsupported = Object.keys(query ?? {}).find((field) => field !== 'branch_id');
  if (unsupported) {
    throw new BadRequest('OpenCode configuration discovery accepts only an optional branch ID.');
  }

  const rawBranchId = query?.branch_id;
  if (rawBranchId !== undefined && typeof rawBranchId !== 'string') {
    throw new BadRequest('Branch ID must be a string.');
  }
  const branchId = rawBranchId?.trim();
  if (rawBranchId !== undefined && !branchId) {
    throw new BadRequest('Branch ID cannot be empty.');
  }
  if (!branchId) return undefined;

  return runWithTenantDatabaseScope(input.db, input.context.tenantId, async (tenantDb) => {
    const branchRepo = new BranchRepository(tenantDb);
    const branch = await branchRepo.findById(branchId);
    if (!branch) throw new Forbidden('OpenCode configuration branch is not authorized.');
    const callerId = input.context.subjectUserId as UUID;
    const effectiveAccess = await branchRepo.resolveUserAccess(branch, callerId);
    if (
      !hasBranchPermission(
        branch,
        callerId,
        effectiveAccess.is_owner,
        'view',
        input.params?.user?.role,
        input.config.execution?.allow_superadmin === true,
        effectiveAccess.can
      ) ||
      (effectiveAccess.fs_access !== 'read' && effectiveAccess.fs_access !== 'write')
    ) {
      throw new Forbidden('OpenCode configuration branch is not authorized.');
    }
    return branch.path;
  });
}
