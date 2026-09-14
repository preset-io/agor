import type { Task } from '@agor/core/types';

/** Internal Slack recovery authority and routing never cross API or realtime boundaries. */
export function stripMcpSlackRecoveryNotice(task: Task): Task {
  if (!task.metadata?.mcp_slack_recovery_notice && !task.metadata?.gateway_task_source) return task;
  const metadata = { ...task.metadata };
  delete metadata.mcp_slack_recovery_notice;
  delete metadata.gateway_task_source;
  return { ...task, metadata };
}

/** Keep the action while hiding attached-server topology from broader Task viewers. */
export function redactMcpRecoveryTopology(task: Task): Task {
  const stripped = stripMcpSlackRecoveryNotice(task);
  const recovery = stripped.metadata?.mcp_recovery;
  if (!recovery) return stripped;
  const affectedCount = recovery.server_states?.length ?? (recovery.mcp_server_id ? 1 : 0);
  return {
    ...stripped,
    metadata: {
      ...stripped.metadata,
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
