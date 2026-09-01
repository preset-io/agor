import {
  getMCPEgressGatewayMode,
  MCPServerRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { HookContext, MCPServerID } from '@agor/core/types';
import type { MCPEgressGateway } from './gateway.js';

type GatewayAbortCoordinator = Pick<MCPEgressGateway, 'abortServer' | 'abortTenant'>;

/** Durable session detach first, then a scoped local cancellation accelerator. */
export async function coordinateSessionMCPRevocation<T>(input: {
  db: TenantScopeAwareDatabase;
  gateway: GatewayAbortCoordinator;
  tenantId?: string;
  serverIds: string[];
  mutate: () => Promise<T>;
}): Promise<T> {
  const result = await input.mutate();
  const mode = await getMCPEgressGatewayMode(input.db);
  if (mode !== 'compatibility' && mode !== 'enforced') return result;
  if (!input.tenantId) return result;
  for (const requestedId of [...new Set(input.serverIds)]) {
    const serverId = await new MCPServerRepository(input.db)
      .resolveCanonicalId(requestedId)
      .catch(() => requestedId as MCPServerID);
    input.gateway.abortServer(input.tenantId, serverId, 'server_detached');
  }
  return result;
}

/** Actual mcp-servers after-write coordination shared by patch/update/remove. */
export function coordinateMCPServerMutationAfterWrite(
  context: HookContext,
  gateway: Pick<MCPEgressGateway, 'abortServer'> | undefined
): void {
  const tenantId = context.params.tenant?.tenant_id;
  const serverId = (context.result as { mcp_server_id?: unknown } | undefined)?.mcp_server_id;
  if (tenantId && typeof serverId === 'string') {
    gateway?.abortServer(tenantId, serverId, 'stale_capability');
  }
}

/** Durable rollout write first, then tenant-scoped local cancellation. */
export async function coordinateMCPEgressRolloutChange<T>(input: {
  gateway: Pick<MCPEgressGateway, 'abortTenant'>;
  tenantId?: string;
  mutate: () => Promise<T>;
}): Promise<T> {
  const result = await input.mutate();
  if (input.tenantId) input.gateway.abortTenant(input.tenantId);
  return result;
}
