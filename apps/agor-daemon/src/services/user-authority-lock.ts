import {
  executeRaw,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, Params } from '@agor/core/types';

const USER_AUTHORITY_LOCK_NAMESPACE = 'agor:user-role-authority:v1';

/**
 * Serialize human user-authority decisions within one PostgreSQL tenant.
 *
 * Callers must already be inside the request's tenant transaction. Sharing
 * this lock between user CRUD and related access mutations prevents a role
 * demotion from racing an operation authorized by the actor's previous role.
 * SQLite callers obtain equivalent serialization by running the complete
 * authority decision and write in an immediate tenant database transaction.
 */
export async function lockUserAuthorityMutation(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  params?: Params
): Promise<void> {
  const user = (params as AuthenticatedParams | undefined)?.user;
  if (!user || user._isServiceAccount || !isPostgresDatabaseHandle(db)) return;

  const scope = getCurrentTenantDatabaseScope();
  if (scope?.kind !== 'tenant' || !scope.transactionActive) {
    throw new Error('User authority mutations require an active tenant transaction');
  }
  const tenantId = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
  if (!scope.tenantId || (tenantId && tenantId !== scope.tenantId)) {
    throw new Error('User authority mutation tenant does not match the active transaction');
  }
  const lockKey = `${USER_AUTHORITY_LOCK_NAMESPACE}:${scope.tenantId}`;
  await executeRaw(
    db,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
  );
}
