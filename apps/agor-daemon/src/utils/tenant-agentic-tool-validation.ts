import { isTenantAgenticToolEnabled } from '@agor/core/config';
import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { AgenticToolName } from '@agor/core/types';

/**
 * Read tenant-owned agentic-tool policy in one short tenant database unit.
 *
 * Long-running orchestration routes carry tenant identity without retaining a
 * PostgreSQL transaction. Keeping this wrapper next to their launch helpers
 * prevents a direct repository read from silently escaping RLS (static mode)
 * or failing the guarded database proxy (required-from-auth mode).
 */
export async function isAgenticToolEnabledForTenant(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  tool: AgenticToolName
): Promise<boolean> {
  return runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
    isTenantAgenticToolEnabled(tool, tenantDb)
  );
}
