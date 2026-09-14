/** Narrow database primitives shared by durable, tenant-owned authorities. */

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { getCurrentTenantDatabaseScope } from '../tenant-context';
import { RepositoryError } from './base';

const SAFE_AUTHORITY_FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

export function assertAuthorityFailureCode(code: string, subject: string): void {
  if (!SAFE_AUTHORITY_FAILURE_CODE.test(code)) {
    throw new RepositoryError(`${subject} failure code is invalid`);
  }
}

/**
 * Acquire an exact transaction-scoped advisory lock after proving that the
 * caller owns the active tenant transaction. The lock key remains domain-owned
 * so existing authorities preserve their deployed coordination namespace.
 */
export async function lockTenantAuthoritySubject(
  db: Database,
  tenantId: string,
  lockKey: string,
  seed = 0
): Promise<void> {
  const scope = getCurrentTenantDatabaseScope();
  if (
    scope?.kind !== 'tenant' ||
    !scope.transactionActive ||
    scope.db !== db ||
    scope.tenantId !== tenantId
  ) {
    throw new RepositoryError('Authority lock requires its active tenant transaction');
  }
  await executeRaw(
    db,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${lockKey}, ${seed})
    )`
  );
}
