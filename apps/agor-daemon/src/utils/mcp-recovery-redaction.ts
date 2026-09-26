import type { Message, Task } from '@agor/core/types';

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

/**
 * Internal Slack connect delivery state never crosses API or realtime
 * boundaries.
 *
 * Same rule as `stripMcpSlackRecoveryNotice`, applied to the widget message
 * that carries the connect lane's durable record. The record is deliberately
 * routing-free of the *binding* — every authority the redemption checks is
 * re-read from its own row — but it is daemon-owned lifecycle state: a one-use
 * identity, an issue epoch, a provider-attempt lease, and now the Slack
 * message coordinates the Block Kit projection edits in place. None of that is
 * anything a transcript viewer has a use for.
 *
 * `slack_connect_due_at` goes with it. It exists before any delivery record
 * does — it is the mint-time marker that puts a widget on the repair sweep —
 * so stripping only `slack_connect` would publish the one field that is set
 * exactly when the card has not been posted yet.
 */
export function stripWidgetSlackConnectDelivery(message: Message): Message {
  const widget = message.metadata?.widget;
  if (!widget?.slack_connect && !widget?.slack_connect_due_at) return message;
  const { slack_connect: _slackConnect, slack_connect_due_at: _dueAt, ...rest } = widget;
  return { ...message, metadata: { ...message.metadata, widget: rest } };
}
