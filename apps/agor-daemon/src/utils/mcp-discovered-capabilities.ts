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
 * configuration CRUD that `authorizeMcpServerWrite` is wired to. That is the
 * decision #2240 documents at `denyDiscoverOfAnotherUsersServer`, and the
 * reason it holds is that the authorizer gates *who* may configure a server,
 * while a refresh configures nothing: the payload is the server's own report
 * of itself, not anything the caller submitted.
 *
 * Routing through it would not be inert, which is the part worth being precise
 * about. Called internally it still enforces nothing — `decidePolicyAndOwnership`
 * returns early on a missing `provider`. Called with the caller's params it
 * would work, and would add two refusals: a `viewer` who still owns a server
 * from before a demotion, and any member under `use_existing_only`. The second
 * is why this stays out. A private server keeps resolving into its owner's
 * sessions no matter what the policy later says (`isMCPServerUsableBy`), so
 * revoking refresh does not stop it being used — it freezes the tool list the
 * agent actually sees. Tightening the policy would make live servers rot.
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
