import { loadConfigSync } from '@agor/core/config';
import {
  BranchRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, OpenCodeModelCatalog, UUID } from '@agor/core/types';
import { hasBranchPermission } from '../../utils/branch-authorization.js';
import { runExecutorCommand } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { createOpenCodeExecutorInvocation } from './executor-command.js';

type ModelCatalogQuery = { branch_id?: string };

export class OpenCodeModelsService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async find(
    params?: AuthenticatedParams & { query?: ModelCatalogQuery }
  ): Promise<OpenCodeModelCatalog> {
    const config = loadConfigSync();
    const context = await resolveAuthenticatedOpenCodeSubjectContext(this.db, params, config);
    const callerId = context.subjectUserId;
    const query = params?.query;
    const userRole = params?.user?.role;
    const unsupported = Object.keys(query ?? {}).find((field) => field !== 'branch_id');
    if (unsupported) {
      throw new BadRequest('OpenCode model discovery accepts only an optional branch ID.');
    }

    let directory: string | undefined;
    const rawBranchId = query?.branch_id;
    if (rawBranchId !== undefined && typeof rawBranchId !== 'string') {
      throw new BadRequest('Branch ID must be a string.');
    }
    const branchId = rawBranchId?.trim();
    if (rawBranchId !== undefined && !branchId) {
      throw new BadRequest('Branch ID cannot be empty.');
    }
    if (branchId) {
      directory = await runWithTenantDatabaseScope(this.db, context.tenantId, async (tenantDb) => {
        const branchRepo = new BranchRepository(tenantDb);
        const branch = await branchRepo.findById(branchId);
        if (!branch) throw new Forbidden('OpenCode model catalog branch is not authorized.');
        if (config.execution?.branch_rbac === true) {
          const effectiveAccess = await branchRepo.resolveUserAccess(branch, callerId as UUID);
          if (
            !hasBranchPermission(
              branch,
              callerId as UUID,
              false,
              'view',
              userRole,
              config.execution?.allow_superadmin === true,
              effectiveAccess.can
            ) ||
            (effectiveAccess.fs_access !== 'read' && effectiveAccess.fs_access !== 'write')
          ) {
            throw new Forbidden('OpenCode model catalog branch is not authorized.');
          }
        }
        return branch.path;
      });
    }

    let result: Awaited<ReturnType<typeof runExecutorCommand>>;
    try {
      result = await runExecutorCommand(
        createOpenCodeExecutorInvocation(context.dataHome, {
          operation: 'discover-models',
          ...(directory ? { directory } : {}),
        }),
        {
          asUser: context.asUser,
          env: context.executorEnv,
          logPrefix: '[OpenCode Models]',
          templateVariables: { unix_user: context.asUser ?? undefined },
        }
      );
    } catch {
      throw new BadRequest('OpenCode model discovery failed. Try again.');
    }
    if (!result.success || !result.data) {
      throw new BadRequest('OpenCode model discovery failed. Try again.');
    }
    return result.data as OpenCodeModelCatalog;
  }
}

export function createOpenCodeModelsService(db: TenantScopeAwareDatabase) {
  return new OpenCodeModelsService(db);
}
