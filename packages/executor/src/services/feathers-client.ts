/**
 * Executor Daemon Client
 *
 * Creates the executor's authenticated Feathers connection for daemon service
 * operations. The daemon-issued credential establishes the trusted tenant and
 * principal at the Socket.IO handshake; service hooks own authorization after
 * that point.
 */

import { type AgorClient, createClient } from '@agor/core/api';
import {
  EXECUTOR_FEATHERS_ACK_TIMEOUT_MS,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@agor/core/config';
import { isTerminalTaskStatus, type WorkloadCompletionReceipt } from '@agor/core/types';

// Re-export AgorClient type for use in other executor files
export type { AgorClient } from '@agor/core/api';

const DEBUG_FEATHERS_CLIENT =
  process.env.AGOR_DEBUG_FEATHERS_CLIENT === '1' || process.env.DEBUG?.includes('feathers-client');

const SERVER_DISCONNECT_RECONNECT_BASE_DELAY_MS = 1000;
const SERVER_DISCONNECT_RECONNECT_MAX_DELAY_MS = 30_000;
const SERVER_DISCONNECT_RECONNECT_MAX_ATTEMPTS = 8;

export const EXECUTOR_REQUEST_DATA_BUDGET_BYTES = SOCKET_IO_MAX_BUFFER_SIZE_BYTES - 200_000;

function feathersClientDebug(...args: unknown[]): void {
  if (DEBUG_FEATHERS_CLIENT) {
    console.debug(...args);
  }
}

export function registerExecutorRequestSizeGuard(client: AgorClient): void {
  client.hooks({
    before: {
      all: [
        async (context) => {
          const path = String(context.path);
          const isTranscriptWrite =
            path === 'messages' && (context.method === 'create' || context.method === 'patch');
          if (!isTranscriptWrite) return context;

          let byteSize: number;
          try {
            byteSize = Buffer.byteLength(JSON.stringify(context.data), 'utf8');
          } catch {
            throw new Error(
              `Executor transcript data could not be serialized (${path}.${context.method})`
            );
          }
          if (byteSize > EXECUTOR_REQUEST_DATA_BUDGET_BYTES) {
            throw new Error(
              `Executor transcript data is ${byteSize} bytes, exceeding the ${EXECUTOR_REQUEST_DATA_BUDGET_BYTES}-byte transport budget (${path}.${context.method}). ` +
                `Reduce the tool result size at the source (e.g. pagination, filtering, or result limits).`
            );
          }
          return context;
        },
      ],
    },
  });
}

export function registerTerminalTaskAcknowledgementHook(
  client: AgorClient,
  onTerminalTaskAcknowledged: () => void
): void {
  client.hooks({
    after: {
      all: [
        async (context) => {
          if (
            context.path === 'tasks' &&
            context.method === 'patch' &&
            isTerminalTaskStatus(context.result?.status)
          ) {
            onTerminalTaskAcknowledged();
          }
          return context;
        },
      ],
    },
  });
}

/**
 * Create a Feathers client with daemon-issued handshake authentication.
 *
 * @param daemonUrl - URL of the daemon (e.g., http://localhost:3030)
 * @param sessionToken - Daemon-issued executor credential
 * @returns Authenticated Feathers client
 */
export interface ExecutorClientHooks {
  /**
   * Fired after a reconnect handshake has re-established the executor's
   * immutable authority. Long-running commands (e.g. the zellij terminal
   * bridge) use this to re-establish socket-scoped state that a fresh socket
   * loses — channel room membership and readiness announcements — which the
   * auto-reconnect transport cannot restore on its own. Never fired for the
   * initial connect; only for reconnects.
   */
  onReconnected?: () => void | Promise<void>;
}

const completionReceiptSetters = new WeakMap<
  AgorClient,
  (receipt: WorkloadCompletionReceipt | null) => void
>();

/** Arm the next authenticated handshake with one exact workload receipt. */
export function setExecutorWorkloadCompletionReceipt(
  client: AgorClient,
  receipt: WorkloadCompletionReceipt | null
): void {
  completionReceiptSetters.get(client)?.(receipt);
}

/** Reopen the socket so the next handshake carries the exact receipt. */
export function reconnectExecutorClientForCompletionReceipt(client: AgorClient): Promise<void> {
  const socket = (client as AgorClient & { io?: typeof client.io }).io;
  if (!socket) return Promise.resolve();
  if (socket.connected) socket.disconnect();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Executor completion receipt reconnect timed out'));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    socket.once('connect', onConnect);
    socket.connect();
  });
}

export async function createExecutorClient(
  daemonUrl: string,
  sessionToken: string,
  hooks?: ExecutorClientHooks
): Promise<AgorClient> {
  const startedAt = Date.now();
  const logSocketEvent = (event: string, detail?: unknown) => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const suffix =
      detail === undefined ? '' : `: ${detail instanceof Error ? detail.message : String(detail)}`;
    console.log(`[executor] Socket ${event} after ${elapsedSeconds}s${suffix}`);
  };

  let completionReceipt: WorkloadCompletionReceipt | null = null;

  // The credential is available before the transport exists. Present it on
  // every namespace handshake so the daemon installs immutable principal and
  // tenant authority (plus task/branch context when present) before accepting
  // the socket.
  const client = createClient(daemonUrl, false, {
    verbose: DEBUG_FEATHERS_CLIENT, // Log connection status for debugging
    // Executors may run for much longer than common proxy/websocket connection
    // caps (for example, 15-minute ingress/LB limits). A short retry budget
    // turns a recoverable transport rotation into a permanent daemon
    // disconnect: heartbeats stop, terminal task patches are lost, and the
    // daemon eventually marks the task failed via stale heartbeat/onExit
    // safety nets. Match the browser client and keep retrying for a live
    // credential's lifetime. Every automatic reconnect performs a fresh
    // authenticated handshake with the same bearer.
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    ackTimeout: EXECUTOR_FEATHERS_ACK_TIMEOUT_MS,
    socketAuthentication: {
      accessToken: sessionToken,
      authData: () => (completionReceipt ? { completionReceipt } : {}),
    },
  });
  completionReceiptSetters.set(client, (receipt) => {
    completionReceipt = receipt;
  });
  let terminalTaskAcknowledged = false;
  registerExecutorRequestSizeGuard(client);
  registerTerminalTaskAcknowledgementHook(client, () => {
    terminalTaskAcknowledged = true;
  });

  let serverDisconnectReconnectAttempts = 0;
  let serverDisconnectReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveringServerDisconnect = false;
  const resetServerDisconnectRecovery = () => {
    serverDisconnectReconnectAttempts = 0;
    recoveringServerDisconnect = false;
    if (serverDisconnectReconnectTimer) {
      clearTimeout(serverDisconnectReconnectTimer);
      serverDisconnectReconnectTimer = undefined;
    }
  };

  let hasConnectedOnce = false;
  let restoreAfterReconnect: Promise<void> | null = null;
  const restoreSocketState = (): void => {
    if (!hooks?.onReconnected || restoreAfterReconnect) return;
    restoreAfterReconnect = Promise.resolve(hooks.onReconnected())
      .catch((error) => {
        console.error('[executor] Post-reconnect recovery failed:', error);
      })
      .finally(() => {
        restoreAfterReconnect = null;
      });
  };

  client.io.on('connect', () => {
    const isReconnect = hasConnectedOnce;
    hasConnectedOnce = true;
    resetServerDisconnectRecovery();
    if (isReconnect) restoreSocketState();
  });

  const scheduleServerDisconnectReconnect = () => {
    if (serverDisconnectReconnectTimer) return;

    if (serverDisconnectReconnectAttempts >= SERVER_DISCONNECT_RECONNECT_MAX_ATTEMPTS) {
      logSocketEvent(
        'server_disconnect_reconnect_abandoned',
        `after ${serverDisconnectReconnectAttempts} attempts`
      );
      recoveringServerDisconnect = false;
      return;
    }

    serverDisconnectReconnectAttempts += 1;
    const delayMs =
      serverDisconnectReconnectAttempts === 1
        ? 0
        : Math.min(
            SERVER_DISCONNECT_RECONNECT_BASE_DELAY_MS *
              2 ** (serverDisconnectReconnectAttempts - 2),
            SERVER_DISCONNECT_RECONNECT_MAX_DELAY_MS
          );

    logSocketEvent(
      'server_disconnect_reconnect_scheduled',
      `attempt ${serverDisconnectReconnectAttempts} in ${delayMs}ms`
    );

    serverDisconnectReconnectTimer = setTimeout(() => {
      serverDisconnectReconnectTimer = undefined;
      // Socket.IO may deliver an acknowledgement and the following namespace
      // disconnect in one transport batch. Client after-hooks settle on the
      // next microtask, so re-check before reopening the now-revoked bearer.
      if (terminalTaskAcknowledged) {
        resetServerDisconnectRecovery();
        return;
      }
      client.io.connect();
    }, delayMs);
  };

  // Connect the socket
  client.io.on('disconnect', (reason: string) => {
    logSocketEvent('disconnected', reason);

    if (reason === 'io server disconnect') {
      if (terminalTaskAcknowledged) {
        resetServerDisconnectRecovery();
        return;
      }
      // Socket.IO intentionally disables automatic reconnect after a server-
      // initiated namespace disconnect. In practice, long executor tasks can
      // see this at the same ~15-minute boundary as proxy transport rotation.
      // Treat it as recoverable for executor lifetimes and explicitly reopen
      // the socket. The new handshake revalidates the scoped bearer before the
      // connect handler restores task/terminal socket state.
      recoveringServerDisconnect = true;
      scheduleServerDisconnectReconnect();
    }
  });

  client.io.on('connect_error', (error: Error) => {
    logSocketEvent('connect_error', error);
    // A server-initiated disconnect disables Socket.IO's normal manager retry.
    // Keep the explicit bounded recovery loop alive when its handshake fails;
    // revoked/expired credentials therefore fail closed after the cap rather
    // than spinning forever.
    if (recoveringServerDisconnect) scheduleServerDisconnectReconnect();
  });

  client.io.io.on('reconnect_attempt', (attemptNumber: number) => {
    logSocketEvent('reconnect_attempt', `attempt ${attemptNumber}`);
  });

  client.io.io.on('reconnect_error', (error: Error) => {
    logSocketEvent('reconnect_error', error);
  });

  client.io.io.on('reconnect_failed', () => {
    logSocketEvent('reconnect_failed');
  });

  client.io.connect();

  // Wait for the daemon to accept the authenticated namespace handshake.
  // The caller cannot clean up a client that was never returned, so close it
  // here on initial failure (especially important with infinite transport
  // reconnection configured for successfully-started long-running tasks).
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 5000);

      client.io.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.io.once('connect_error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    client.io.close();
    throw error;
  }

  feathersClientDebug('[executor] Connected to daemon with authenticated handshake');

  // Manager-level reconnects retain the same Socket/Feathers client. The
  // namespace `connect` listener above restores socket-scoped state after the
  // daemon accepts the new authenticated handshake.
  client.io.io.on('reconnect', (attemptNumber: number) => {
    logSocketEvent('reconnected', `attempt ${attemptNumber}`);
  });

  return client;
}
