import {
  executeRaw,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, Params } from '@agor/core/types';

const TENANT_AUTHORIZATION_FENCE_NAMESPACE = 'agor:tenant-authorization:v1';

/**
 * Serialize authorization decisions and authority mutations within one
 * PostgreSQL tenant.
 *
 * Callers must already be inside the request's tenant transaction. Sharing
 * this lock between every tenant authority writer and durable admission
 * prevents a revocation from racing an operation authorized by stale state.
 * SQLite callers obtain equivalent serialization by running the complete
 * authority decision and write in an immediate tenant database transaction.
 */
export async function lockTenantAuthorizationFence(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  params?: Params
): Promise<void> {
  if (!isPostgresDatabaseHandle(db)) return;

  const scope = getCurrentTenantDatabaseScope();
  if (scope?.kind !== 'tenant' || !scope.transactionActive) {
    throw new Error('Tenant authority operations require an active tenant transaction');
  }
  const tenantId = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
  if (!scope.tenantId || (tenantId && tenantId !== scope.tenantId)) {
    throw new Error('Tenant authority operation does not match the active transaction');
  }
  const lockKey = `${TENANT_AUTHORIZATION_FENCE_NAMESPACE}:${scope.tenantId}`;
  await executeRaw(
    db,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
  );
}
