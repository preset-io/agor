import {
  enqueueAfterTenantDatabaseCommit,
  getCurrentTenantId,
  getMCPEgressGatewayMode,
  runWithoutTenantDatabaseScope,
  runWithTenantContext,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { MCPRuntimeProviderCapability, Task, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

const DIRECT_RECOVERY_LIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.RUNNING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
]);

export const DIRECT_MODE_MCP_RECOVERY_MESSAGE =
  'MCP gateway mediation is not active. Current direct-mode MCP configuration applies on the next turn; this conversation is unchanged.';

export function didMcpPrincipalRoleChange(
  patch: unknown,
  previousRole: string | undefined,
  resultingRole: string | undefined
): boolean {
  return (
    !!patch &&
    typeof patch === 'object' &&
    'role' in patch &&
    previousRole !== undefined &&
    resultingRole !== undefined &&
    previousRole !== resultingRole
  );
}

export async function isMcpRuntimeRecoveryEnabled(db: TenantScopeAwareDatabase): Promise<boolean> {
  const mode = await getMCPEgressGatewayMode(db);
  return mode === 'compatibility' || mode === 'enforced';
}

export async function degradeMcpRuntimeRecoveryForDirectMode(
  db: TenantScopeAwareDatabase,
  taskId: TaskID,
  provider: MCPRuntimeProviderCapability
): Promise<{ task: Task; changed: boolean }> {
  const repository = new TaskRepository(db);
  if (await isMcpRuntimeRecoveryEnabled(db)) {
    return {
      task: await repository.recordMCPRecovery(taskId, () => null),
      changed: false,
    };
  }
  const degradedAt = new Date().toISOString();
  const task = await repository.recordMCPRecovery(taskId, (current, lockedTask) => {
    if (
      (current?.status !== 'refresh_requested' && current?.action !== 'reconnect_mcp') ||
      !DIRECT_RECOVERY_LIVE_STATUSES.has(lockedTask.status)
    ) {
      return null;
    }
    return {
      ...current,
      generation: current.generation + 1,
      code: 'rollout_changed',
      status: 'action_required',
      provider,
      action: 'retry_next_turn',
      mcp_server_id: undefined,
      mcp_server_name: undefined,
      server_states: undefined,
      message: DIRECT_MODE_MCP_RECOVERY_MESSAGE,
      observed_at: degradedAt,
      request_id: undefined,
      refresh_deadline_at: undefined,
    };
  });
  return {
    task,
    changed:
      task.metadata?.mcp_recovery?.status === 'action_required' &&
      task.metadata.mcp_recovery.observed_at === degradedAt,
  };
}

/**
 * Schedule an availability-only MCP recovery hint after the authoritative
 * mutation commits. The callback returns before the work starts, so fanout
 * latency or failure can never change the mutation's result.
 */
export function scheduleMcpRuntimeHint(
  _db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  code: string,
  work: () => Promise<void>
): void {
  const exactTenantId = tenantId ?? getCurrentTenantId();
  if (!exactTenantId) {
    console.warn(`[MCP Runtime] event=hint_skipped code=${code} reason=missing_tenant`);
    return;
  }
  const dispatch = () => {
    queueMicrotask(() => {
      // Start from an already-resolved promise so a synchronous tenant/scope
      // setup failure is contained by the same availability-only tail as an
      // asynchronous fanout failure.
      void Promise.resolve()
        .then(() => runWithoutTenantDatabaseScope(() => runWithTenantContext(exactTenantId, work)))
        .catch(() => {
          console.warn(`[MCP Runtime] event=hint_failed code=${code}`);
        });
    });
  };

  if (!enqueueAfterTenantDatabaseCommit(dispatch)) dispatch();
}
