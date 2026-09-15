import { sql } from 'drizzle-orm';
import { McpOAuthIdSchema } from '../../types/mcp-managed-oauth-contract';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, rawRows } from '../database-wrapper';
import { getCurrentTenantDatabaseScope } from '../tenant-context';
import { RepositoryError } from './base';

/**
 * IDs queue tenant-scoped work only; no credential authority crosses this boundary.
 * Omit cellId for explicit whole-database maintenance. Cell-decommission callers
 * first verify the immutable cell barrier, then pass its exact cell on every page.
 */
export async function listManagedOAuthMaintenanceTenants(
  db: Database,
  cursor?: string,
  limit = 100,
  cellId?: string
): Promise<{ tenantIds: string[]; nextCursor: string | null }> {
  const scope = getCurrentTenantDatabaseScope();
  if (
    !isPostgresDatabase(db) ||
    scope?.kind !== 'system' ||
    scope.systemCapability !== 'mcp_oauth_maintenance' ||
    scope.db !== db
  )
    throw new RepositoryError('Managed OAuth routing requires its system maintenance capability');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 1024))
  )
    throw new RepositoryError('Invalid managed maintenance page');
  if (cellId !== undefined) McpOAuthIdSchema.parse(cellId);
  const rows = rawRows(
    await executeRaw(
      db,
      sql`SELECT tenant_id FROM public.agor_mcp_managed_oauth_maintenance_tenants(${cursor ?? null},${limit},${cellId ?? null})`
    )
  );
  if (rows.length > limit || rows.some((row) => typeof row.tenant_id !== 'string'))
    throw new RepositoryError('Invalid managed maintenance routing result');
  const tenantIds = rows.map((row) => String(row.tenant_id));
  return {
    tenantIds,
    nextCursor: tenantIds.length === limit ? tenantIds[tenantIds.length - 1] : null,
  };
}
