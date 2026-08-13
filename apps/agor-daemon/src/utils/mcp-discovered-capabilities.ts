import { MCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { MCPCapabilities } from '@agor/core/types';
import { runInOAuthTenantWriteScope } from '../oauth-auth-helpers.js';

/**
 * Persist the capability lists a discovery probe read off an MCP server.
 *
 * This deliberately does not go through `app.service('mcp-servers').patch`,
 * which is the entry point for configuration CRUD and the one the tenant's
 * write authorization is wired to. Two reasons, both structural:
 *
 * - The payload is not the caller's. `tools` / `resources` / `prompts` are
 *   whatever the remote server answered; discovery's own owner/admin rule
 *   decides who may ask, and there is no caller-supplied field left for a
 *   configuration authorizer to judge. `UpdateMCPServerInput` cannot carry
 *   `owner_user_id`, so this write cannot move a row between owners.
 * - The service's write pipe exists to react to configuration changes. Its
 *   around-hook takes an OAuth grant configuration lock and re-reads the row
 *   twice to decide whether to invalidate every grant on the server. A
 *   capability refresh changes none of the fields that decision looks at, so
 *   routing through it would pay for an answer that is always "no change".
 *
 * What discovery does still owe the tenant is the database boundary every
 * other write in this endpoint honors. `/mcp-servers/discover` carries tenant
 * identity only — it performs network I/O, so it must not hold an HTTP-long
 * transaction — which means each database touch opens its own short tenant
 * unit of work. Without one, the guarded database handle has no scope to
 * route to and the per-tenant write gate never gets consulted.
 */
export async function persistDiscoveredMCPCapabilities(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  serverId: string,
  capabilities: MCPCapabilities
): Promise<void> {
  await runInOAuthTenantWriteScope(db, tenantId, async () => {
    await new MCPServerRepository(db).update(serverId, {
      tools: capabilities.tools ?? [],
      resources: capabilities.resources ?? [],
      prompts: capabilities.prompts ?? [],
    });
  });
}
