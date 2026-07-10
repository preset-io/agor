import { runWithTenantDatabaseScope } from '@agor/core/db';
import type { McpContext } from './server.js';

/**
 * Custom MCP service methods bypass the Feathers around hooks that normally
 * enter the tenant database scope. Re-enter that scope when authentication
 * supplied a tenant, while preserving static/single-tenant behavior.
 */
export async function runWithMcpTenantScope<T>(
  ctx: McpContext,
  work: () => Promise<T>
): Promise<T> {
  const tenantId = ctx.baseServiceParams.tenant?.tenant_id;
  if (!tenantId) return work();
  return runWithTenantDatabaseScope(ctx.db, tenantId, work);
}
