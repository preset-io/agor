import { resolveUserEnvironment } from '@agor/core/config';
import {
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { filterUserGitEnvironment, type UserGitEnvironment } from '@agor/core/git/pure';
import type { AuthenticatedParams, Params, UserID } from '@agor/core/types';
import {
  parseGitBranchAddExecutorCommandId,
  parseGitCloneExecutorCommandId,
} from '../auth/executor-command-ids.js';
import { authenticatedExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';

/**
 * Command-scoped plaintext capability for managed Git transport.
 *
 * Managed env values remain write-only to browsers, ordinary user JWTs,
 * admins, and generic service calls. Only the daemon-issued executor token for
 * the exact git.clone / git.branch.add command can resolve the initiating
 * user's bounded Git HTTP transport DTO.
 */
export class ExecutorGitEnvironmentService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async create(_data: Record<string, never>, params?: Params): Promise<UserGitEnvironment> {
    if (!params?.provider) {
      throw new Forbidden('Git environment capability requires an authenticated transport');
    }
    const caller = (params as AuthenticatedParams | undefined)?.user;
    if (!caller) throw new NotAuthenticated('Authentication required');

    const scope = authenticatedExecutorCommandRuntimeScope(params);
    if (
      !scope ||
      (!parseGitCloneExecutorCommandId(scope.commandId) &&
        !parseGitBranchAddExecutorCommandId(scope.commandId))
    ) {
      throw new Forbidden('A Git executor command token is required');
    }

    const tenantId = requireCurrentTenantId();
    const resolved = await runWithTenantDatabaseScope(this.db, tenantId, (tenantDb) =>
      resolveUserEnvironment(caller.user_id as UserID, tenantDb)
    );
    return filterUserGitEnvironment(resolved).env;
  }
}

export function createExecutorGitEnvironmentService(
  db: TenantScopeAwareDatabase
): ExecutorGitEnvironmentService {
  return new ExecutorGitEnvironmentService(db);
}
