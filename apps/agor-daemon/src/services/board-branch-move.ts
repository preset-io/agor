import { enqueueAfterTenantDatabaseCommit, getCurrentTenantId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  BRANCH_REVOCATION_SCOPE,
  LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT,
} from '../realtime/routing.js';
import { classifyBranchBoardMoveInvalidation } from '../utils/branch-board-move-invalidation.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import type { BoardsServiceDependencies } from './boards.js';
import type { BranchesService } from './branches.js';

/** Command dependency for Assign's outer transaction; never call wrapped CRUD here. */
export function createBoardBranchMover(
  app: Application,
  branches: Pick<BranchesService, 'patch'>
): NonNullable<BoardsServiceDependencies['moveBranch']> {
  return async (branchId, boardId, params) => {
    const branch = await branches.patch(branchId, { board_id: boardId }, params);
    const tenantId = getCurrentTenantId();
    const mode = classifyBranchBoardMoveInvalidation(params, branch);
    if (tenantId && mode !== 'none') {
      // Publication must see the new audience immediately, but disconnecting
      // the caller here would discard its successful RPC acknowledgement.
      enqueueAfterTenantDatabaseCommit(() => {
        app.emit(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, { tenantId });
      });
      const branchScoped = mode === BRANCH_REVOCATION_SCOPE;
      deferWithTenantContext(
        params,
        async () => {
          app.emit('realtime:authorization-invalidated', {
            tenantId,
            // Cache-only for override branches; for branch scope, pre-scope
            // replicas ignore revocationScope and still evict.
            disconnectSockets: branchScoped,
            ...(branchScoped
              ? { affectedBranchId: branchId, revocationScope: BRANCH_REVOCATION_SCOPE }
              : {}),
          });
        },
        () => console.warn('[realtime] Failed to schedule authorization eviction')
      );
    }
    emitServiceEvent(app, {
      path: 'branches',
      event: 'patched',
      data: branch,
      params,
      id: branchId,
    });
  };
}
