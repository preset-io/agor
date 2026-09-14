import {
  assertTenantWritable,
  requireCurrentTenantId,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { MCPServerID, Task } from '@agor/core/types';

export interface SessionInitializationStageOptions {
  db: TenantScopeAwareDatabase;
  mcpServerIds?: MCPServerID[];
  envVarNames?: string[];
  setMcpServers: (serverIds: MCPServerID[]) => Promise<void>;
  setEnvVarNames: (envVarNames: string[]) => Promise<void>;
  publishMcpServersChanged: (serverIds: MCPServerID[]) => void;
  publishEnvVarNamesChanged: (envVarNames: string[]) => void;
  admitPrompt?: () => Promise<Task>;
}

/**
 * Commit required session configuration as one short metadata transaction,
 * then admit the initial prompt through the normal prompt lifecycle.
 *
 * Prompt admission is intentionally a later stage: its task events and
 * executor dispatch must never escape an outer configuration transaction.
 */
export async function runSessionInitializationStages({
  db,
  mcpServerIds,
  envVarNames,
  setMcpServers,
  setEnvVarNames,
  publishMcpServersChanged,
  publishEnvVarNamesChanged,
  admitPrompt,
}: SessionInitializationStageOptions): Promise<Task | undefined> {
  const tenantId = requireCurrentTenantId('Missing tenant context for session initialization');
  await runWithTenantDatabaseTransaction(db, undefined, async (tenantDb) => {
    await assertTenantWritable(tenantDb, tenantId);
    if (mcpServerIds) await setMcpServers(mcpServerIds);
    if (envVarNames) await setEnvVarNames(envVarNames);

    // Production publishers enqueue while this transaction is active and are
    // drained only after commit by the tenant transaction boundary.
    if (mcpServerIds) publishMcpServersChanged(mcpServerIds);
    if (envVarNames) publishEnvVarNamesChanged(envVarNames);
  });

  return admitPrompt?.();
}
