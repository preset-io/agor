import {
  getMCPEgressGatewayMode,
  MCPServerRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { HookContext, MCPServerID } from '@agor/core/types';
import type { MCPEgressGateway } from './gateway.js';

type GatewayAbortCoordinator = Pick<MCPEgressGateway, 'abortSessionServer'>;

/** Durable session detach first, then a scoped local cancellation accelerator. */
export async function coordinateSessionMCPRevocation<T>(input: {
  db: TenantScopeAwareDatabase;
  gateway: GatewayAbortCoordinator;
  tenantId?: string;
  sessionId: string;
  serverIds: string[];
  mutate: () => Promise<T>;
}): Promise<T> {
  let abortTarget: { tenantId: string; sessionId: string; serverIds: MCPServerID[] } | undefined;
  try {
    const mode = await getMCPEgressGatewayMode(input.db);
    if ((mode === 'compatibility' || mode === 'enforced') && input.tenantId) {
      const session = await new SessionRepository(input.db).findById(input.sessionId);
      if (session) {
        const serverIds = (
          await Promise.allSettled(
            [...new Set(input.serverIds)].map((id) =>
              new MCPServerRepository(input.db).resolveCanonicalId(id)
            )
          )
        ).flatMap((resolved) => (resolved.status === 'fulfilled' ? [resolved.value] : []));
        abortTarget = {
          tenantId: input.tenantId,
          sessionId: session.session_id,
          serverIds,
        };
      }
    }
  } catch {
    console.warn('[MCP Runtime] event=session_abort_skipped code=target_resolution_failed');
  }
  const result = await input.mutate();
  try {
    if (abortTarget) {
      for (const serverId of abortTarget.serverIds) {
        input.gateway.abortSessionServer(abortTarget.tenantId, abortTarget.sessionId, serverId);
      }
    }
  } catch {
    // The session mutation is already authoritative. This local accelerator is
    // availability-only and must never change its committed success response.
    console.warn('[MCP Runtime] event=session_abort_failed code=post_commit_tail');
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
