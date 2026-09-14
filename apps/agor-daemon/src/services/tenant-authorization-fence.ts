import {
  executeRaw,
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, Params, UserID } from '@agor/core/types';

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

export type CurrentTenantAuthorityActor =
  | { kind: 'human'; user_id: UserID; role: string; service: false }
  | { kind: 'service'; user_id: UserID; role?: string; service: true };

/**
 * Reload a human actor after the tenant fence is held.
 *
 * Request claims identify the actor but never authorize the operation: role
 * writers take the same fence, so the row read here observes a demotion that
 * committed first. A missing row is also a hard denial. Service accounts are
 * an explicit trusted principal kind and do not masquerade as persisted users.
 * Actor-less provider-less calls are returned as `null` only at call sites
 * that deliberately opt into a trusted internal seam.
 */
export function resolveCurrentTenantAuthorityActor(
  db: TenantScopedDatabase,
  params?: Params,
  options?: { allowActorlessTrusted?: false }
): Promise<CurrentTenantAuthorityActor>;
export function resolveCurrentTenantAuthorityActor(
  db: TenantScopedDatabase,
  params: Params | undefined,
  options: { allowActorlessTrusted: true }
): Promise<CurrentTenantAuthorityActor | null>;
export async function resolveCurrentTenantAuthorityActor(
  db: TenantScopedDatabase,
  params?: Params,
  options: { allowActorlessTrusted?: boolean } = {}
): Promise<CurrentTenantAuthorityActor | null> {
  const claimed = (params as AuthenticatedParams | undefined)?.user;
  if (claimed?._isServiceAccount) {
    if (!claimed.user_id) throw new NotAuthenticated('Authentication required');
    return {
      kind: 'service',
      user_id: claimed.user_id as UserID,
      role: claimed.role,
      service: true,
    };
  }
  if (!claimed?.user_id) {
    if (!params?.provider && options.allowActorlessTrusted) return null;
    throw new NotAuthenticated('Authentication required');
  }
  const current = await new UsersRepository(db).getWriteAuthorityProjectionForUpdate(
    claimed.user_id
  );
  if (!current) throw new NotAuthenticated('Authentication required');
  return { kind: 'human', ...current, service: false };
}
