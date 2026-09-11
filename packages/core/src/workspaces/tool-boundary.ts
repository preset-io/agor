import { traceBestEffort } from '../tracing/datadog';
import type { BranchWorkspaceCoordinator, CommitOutcome, ToolTicket } from './index';

/**
 * Awaited execution boundary for managed tools. Streaming SDK notifications are
 * deliberately not accepted as a before/after execution fence. The controller
 * owns this object; the child receives only its private cwd and injected secrets.
 */
export async function runWorkspaceTool<T>(
  coordinator: BranchWorkspaceCoordinator,
  identity: { executorId: string; toolId: string; idempotencyKey: string },
  execute: (local: { cwd: string; ticket: ToolTicket }) => Promise<T>
): Promise<{ value: T; outcome: CommitOutcome }> {
  const { ticket, workspace } = await coordinator.beginTool(
    identity.executorId,
    identity.toolId,
    identity.idempotencyKey
  );
  let value: T;
  try {
    // execute must reap all descendants before resolving, including failed tools.
    value = await traceBestEffort(
      coordinator.options.tracer ?? null,
      'workspace.tool',
      {
        ...coordinator.scope,
        executorId: identity.executorId,
        toolId: identity.toolId,
        baseRevision: ticket.baseRevision,
      },
      () => execute({ cwd: workspace, ticket })
    );
  } catch (error) {
    await coordinator.abortTool(ticket).catch(() => {});
    throw error;
  }
  // Do not abort on uncertain commit acknowledgement. The durable ticket lets
  // the controller retry completeTool without ever re-executing the tool.
  const outcome = await coordinator.completeTool(ticket);
  return { value, outcome };
}
