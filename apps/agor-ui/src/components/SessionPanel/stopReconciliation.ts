import type { AgorClient, SessionID, Task, TaskID } from '@agor-live/client';
import { isTerminalTaskStatus, TaskStatus } from '@agor-live/client';

export type StopTransportReconciliation =
  | { outcome: 'accepted'; reason: string }
  | { outcome: 'ended'; reason: string }
  | { outcome: 'unresolved' };

const RECONNECT_POLL_MS = 25;

async function waitForConnectedClient(
  getClient: () => AgorClient | null,
  timeoutMs: number
): Promise<AgorClient | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const client = getClient();
    if (client?.io.connected) return client;
    await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
  } while (Date.now() < deadline);
  return null;
}

/**
 * A Socket.IO acknowledgement can be lost after the Stop claim commits. Never
 * retry the mutation from this path: reconnect and reconcile the exact durable
 * task generation instead, so one click cannot create duplicate side effects.
 */
export async function reconcileStopTransportFailure(
  getClient: () => AgorClient | null,
  sessionId: SessionID,
  taskId: TaskID,
  reconnectTimeoutMs = 2_000
): Promise<StopTransportReconciliation> {
  const client = await waitForConnectedClient(getClient, reconnectTimeoutMs);
  if (!client) return { outcome: 'unresolved' };

  try {
    const task = (await client.service('tasks').get(taskId)) as Task;
    if (task.task_id !== taskId || task.session_id !== sessionId) {
      return { outcome: 'unresolved' };
    }

    if (task.termination_request?.cause === 'user_stop') {
      if (task.status === TaskStatus.STOPPING) {
        return {
          outcome: 'accepted',
          reason: 'Stop was accepted; waiting for executor termination.',
        };
      }
      if (isTerminalTaskStatus(task.status)) {
        return { outcome: 'accepted', reason: 'Stop completed.' };
      }
    }

    if (isTerminalTaskStatus(task.status)) {
      return { outcome: 'ended', reason: 'Execution already ended.' };
    }
  } catch {
    // The durable read may still fail after reconnect (for example an
    // authority change or tenant-safe NotFound). Preserve the original
    // retryable error without weakening authorization or guessing success.
  }
  return { outcome: 'unresolved' };
}
