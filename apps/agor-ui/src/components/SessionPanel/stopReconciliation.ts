import type {
  AgorClient,
  SessionID,
  SessionStopRequest,
  SessionStopResult,
  Task,
  TaskID,
} from '@agor-live/client';
import { isTerminalTaskStatus, TaskStatus } from '@agor-live/client';

export type StopTransportReconciliation =
  | { outcome: 'accepted'; reason: string }
  | { outcome: 'ended'; reason: string }
  | { outcome: 'unresolved' };

const RECONNECT_POLL_MS = 25;
export const STOP_ACK_TIMEOUT_MS = 20_000;

export class StopTransportAmbiguousError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StopTransportAmbiguousError';
  }
}

export function isStopTransportAmbiguous(error: unknown): boolean {
  return error instanceof StopTransportAmbiguousError;
}

function hasFeathersResponseCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'number'
  );
}

/**
 * Stop may wait for cooperative executor quiescence, so the browser cannot use
 * a short global Socket.IO acknowledgement timeout. Bound this one mutation,
 * and fail early on disconnect, so a lost acknowledgement reaches durable
 * reconciliation instead of leaving the footer permanently in-flight.
 */
export function requestSessionStop(
  client: AgorClient,
  sessionId: SessionID,
  expectedTaskId: TaskID,
  timeoutMs = STOP_ACK_TIMEOUT_MS
): Promise<SessionStopResult> {
  const socket = client.io;
  if (!socket.connected) {
    return Promise.reject(new StopTransportAmbiguousError('Socket disconnected before Stop.'));
  }

  return new Promise<SessionStopResult>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('disconnect', onDisconnect);
      work();
    };
    const rejectTransport = (message: string, cause?: unknown) =>
      finish(() =>
        reject(
          new StopTransportAmbiguousError(message, cause === undefined ? undefined : { cause })
        )
      );
    const onDisconnect = () =>
      rejectTransport('Socket disconnected before the Stop acknowledgement.');
    const timeout = setTimeout(
      () => rejectTransport('Timed out waiting for the Stop acknowledgement.'),
      timeoutMs
    );

    socket.once('disconnect', onDisconnect);
    try {
      // Feathers detects the Socket.IO timeout flag and installs the
      // error-aware acknowledgement callback. This also lets Socket.IO retire
      // the callback if the server never acknowledges.
      socket.timeout(timeoutMs);
      const request: SessionStopRequest = { expected_task_id: expectedTaskId };
      void client
        .service(`sessions/${sessionId}/stop`)
        .create(request)
        .then(
          (result) => finish(() => resolve(result as SessionStopResult)),
          (error) => {
            if (hasFeathersResponseCode(error)) {
              finish(() => reject(error));
            } else {
              rejectTransport('The Stop acknowledgement was not received.', error);
            }
          }
        );
    } catch (error) {
      rejectTransport('The Stop request could not be sent.', error);
    }
  });
}

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
