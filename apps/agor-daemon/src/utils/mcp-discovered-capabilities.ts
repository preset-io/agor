import { MCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { MCPPrompt, MCPResource, MCPServerID, MCPTool } from '@agor/core/types';
import { runInOAuthTenantWriteScope } from '../oauth-auth-helpers.js';

/** Every list a probe reports, so a missing one cannot be read as an empty one. */
export interface DiscoveredMCPCapabilities {
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

/**
 * Persist the capability lists a discovery probe read off an MCP server.
 *
 * This does not go through `app.service('mcp-servers')`, the entry point for
 * configuration CRUD that the tenant's write authorization is wired to. There
 * is no version of that route which both works and enforces something:
 *
 * - Called with the caller's params, the service's role gate rejects the
 *   request. Discovery deliberately admits the server's owner and not just an
 *   admin, so every owner's refresh would fail at the persist step, after the
 *   outbound probe already ran.
 * - Called internally, `ensureMinimumRole` returns early on a missing
 *   `provider` and no authorization runs at all — a boundary that reads like
 *   one in review and enforces nothing.
 *
 * The endpoint's own owner/admin rule is therefore the authorization, and it
 * has already run by the time this is reached. Two structural facts keep that
 * narrow: the update input carries no `owner_user_id`, `url` or `auth`, so a
 * refresh cannot move a row between owners or repoint the server; and those
 * are exactly the fields the OAuth grant-invalidation hook inspects, so
 * routing through the service would take an OAuth grant configuration lock and
 * re-read the row twice to reach an answer that is always "no change".
 *
 * The cost of the bypass is that no `mcp-servers` service event is emitted, so
 * other clients keep a stale capability list until they refetch.
 *
 * What discovery does still owe the tenant is the database boundary every
 * other write in this endpoint honors. `/mcp-servers/discover` carries tenant
 * identity only — it performs network I/O, so it must not hold an HTTP-long
 * transaction — which means each database touch opens its own short tenant
 * unit of work. Without one, the guarded database handle has no scope to route
 * to and the per-tenant write gate never gets consulted.
 */
export async function persistDiscoveredMCPCapabilities(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  serverId: MCPServerID,
  capabilities: DiscoveredMCPCapabilities
): Promise<void> {
  await runInOAuthTenantWriteScope(db, tenantId, async () => {
    await new MCPServerRepository(db).update(serverId, {
      tools: capabilities.tools,
      resources: capabilities.resources,
      prompts: capabilities.prompts,
    });
  });
}
