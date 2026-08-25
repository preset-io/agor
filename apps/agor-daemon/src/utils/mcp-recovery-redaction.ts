import type { Task } from '@agor/core/types';

/** Keep the action while hiding attached-server topology from broader Task viewers. */
export function redactMcpRecoveryTopology(task: Task): Task {
  const recovery = task.metadata?.mcp_recovery;
  if (!recovery) return task;
  const affectedCount = recovery.server_states?.length ?? (recovery.mcp_server_id ? 1 : 0);
  return {
    ...task,
    metadata: {
      ...task.metadata,
      mcp_recovery: {
        ...recovery,
        mcp_server_id: undefined,
        mcp_server_name: undefined,
        server_states: undefined,
        message:
          affectedCount > 0
            ? `${recovery.message} ${affectedCount} affected MCP server${affectedCount === 1 ? '' : 's'}; details are available to the session owner or an administrator.`
            : recovery.message,
      },
    },
  };
}
