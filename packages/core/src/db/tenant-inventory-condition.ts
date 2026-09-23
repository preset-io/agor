import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { getCurrentTenantDatabaseScope, requireCurrentTenantId } from './tenant-context';

/** Planner aid for tenant-owned inventories, never a substitute for RLS/RBAC.
 * Explicit system scopes retain their capability-specific database policies.
 * SQLite has no tenant column; its deployment boundary remains unchanged.
 */
export function tenantInventoryCondition(db: Database, table: SQLWrapper): SQL | undefined {
  if (!isPostgresDatabase(db)) return undefined;
  if (getCurrentTenantDatabaseScope()?.kind === 'system') return undefined;
  const tenantId = requireCurrentTenantId();
  return sql`${table}.${sql.identifier('tenant_id')} = ${tenantId}`;
}
