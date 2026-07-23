import {
  type BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  type TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';

export interface StopRouteRepositories {
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  branchRepo: Pick<BranchRepository, 'isOwner'>;
}

/**
 * Direct repository access used by the identity-only Stop route.
 *
 * Service calls establish tenant scopes through their hooks. These repository
 * calls do not, so each must run in its own short tenant unit of work rather
 * than relying on a route-wide transaction.
 */
export function bindStopRouteRepositories(
  db: TenantScopeAwareDatabase,
  repositories: StopRouteRepositories
): StopRouteRepositories {
  return {
    taskRepo: bindRepositoryToTenantUnitOfWork(db, repositories.taskRepo),
    branchRepo: bindRepositoryToTenantUnitOfWork(db, repositories.branchRepo),
  };
}
