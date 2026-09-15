/** Deployment-only stop barrier. No tenant data, credentials, expiry or release path. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { MCPManagedOAuthCellRetirement } from '../../types/mcp-managed-oauth';
import { McpOAuthIdSchema } from '../../types/mcp-managed-oauth-contract';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, rawRows } from '../database-wrapper';
import { getCurrentTenantDatabaseScope } from '../tenant-context';
import { RepositoryError } from './base';

function assertMaintenance(db: Database): void {
  const scope = getCurrentTenantDatabaseScope();
  if (
    scope?.kind !== 'system' ||
    scope.db !== db ||
    scope.systemCapability !== 'mcp_oauth_maintenance' ||
    !isPostgresDatabase(db)
  )
    throw new RepositoryError('Cell retirement requires its system maintenance transaction');
}

export async function readManagedOAuthCellRetirement(
  db: Database,
  cellId: string,
  operationId: string,
  expectedGeneration?: string
): Promise<MCPManagedOAuthCellRetirement | null> {
  assertMaintenance(db);
  McpOAuthIdSchema.parse(cellId);
  McpOAuthIdSchema.parse(operationId);
  const [row] = rawRows(
    await executeRaw(
      db,
      sql`
    SELECT cell_id,operation_id,generation FROM public.mcp_managed_oauth_cell_retirements
    WHERE cell_id=${cellId}`
    )
  );
  if (!row) return null;
  if (row.operation_id !== operationId)
    throw new RepositoryError('Cell retirement operation changed');
  if (
    expectedGeneration !== undefined &&
    row.generation !== McpOAuthIdSchema.parse(expectedGeneration)
  )
    throw new RepositoryError('Cell retirement generation changed');
  return {
    cell_id: McpOAuthIdSchema.parse(row.cell_id),
    operation_id: McpOAuthIdSchema.parse(row.operation_id),
    generation: McpOAuthIdSchema.parse(row.generation),
  };
}

/** Commit this barrier before enumerating tenants. No network or tenant work in this transaction. */
export async function beginManagedOAuthCellRetirement(
  db: Database,
  cellId: string,
  operationId: string
): Promise<MCPManagedOAuthCellRetirement> {
  assertMaintenance(db);
  McpOAuthIdSchema.parse(cellId);
  McpOAuthIdSchema.parse(operationId);
  // Same namespace as 0113's shared vending lock, held until this transaction commits.
  await executeRaw(
    db,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(${`agor:mcp-managed-cell-retirement:v1:${cellId}`},0))`
  );
  const existing = await readManagedOAuthCellRetirement(db, cellId, operationId);
  if (existing) return existing;
  const generation = randomUUID();
  await executeRaw(
    db,
    sql`INSERT INTO public.mcp_managed_oauth_cell_retirements
    (cell_id,operation_id,generation,created_at) VALUES (${cellId},${operationId},${generation},clock_timestamp())`
  );
  return { cell_id: cellId, operation_id: operationId, generation };
}
