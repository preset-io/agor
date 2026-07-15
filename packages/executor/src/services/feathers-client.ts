/**
 * Feathers Client for Executor
 *
 * Creates authenticated connection to daemon for database/service operations.
 * Uses session token for authentication instead of user credentials.
 */

import { type AgorClient, createClient } from '@agor/core/api';

// Re-export AgorClient type for use in other executor files
export type { AgorClient } from '@agor/core/api';

const DEBUG_FEATHERS_CLIENT =
  process.env.AGOR_DEBUG_FEATHERS_CLIENT === '1' || process.env.DEBUG?.includes('feathers-client');

const SERVER_DISCONNECT_RECONNECT_BASE_DELAY_MS = 1000;
const SERVER_DISCONNECT_RECONNECT_MAX_DELAY_MS = 30_000;
const SERVER_DISCONNECT_RECONNECT_MAX_ATTEMPTS = 8;
const SERVER_DISCONNECT_RECONNECT_MAX_AUTH_FAILURES = 3;

function feathersClientDebug(...args: unknown[]): void {
  if (DEBUG_FEATHERS_CLIENT) {
    console.debug(...args);
  }
}

/**
 * In-memory storage for executor authentication
 * Executors need to store authentication for subsequent requests but can't use localStorage
 */
class MemoryStorage {
  private store: Record<string, string> = {};

  async getItem(key: string): Promise<string | null> {
    return this.store[key] || null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store[key] = value;
  }

  async removeItem(key: string): Promise<void> {
    delete this.store[key];
  }
}

/**
 * Create Feathers client connected to daemon with session token authentication
 *
 * @param daemonUrl - URL of the daemon (e.g., http://localhost:3030)
 * @param sessionToken - Session token for authentication
 * @returns Authenticated Feathers client
 */
export interface ExecutorClientHooks {
  /**
   * Fired after the socket reconnects AND successfully re-authenticates as the
   * executor service account. Long-running commands (e.g. the zellij terminal
   * bridge) use this to re-establish socket-scoped state that a fresh socket
   * loses — channel room membership and readiness announcements — which the
   * auto-reconnect transport cannot restore on its own. Never fired for the
   * initial connect; only for reconnects.
   */
  onReauthenticated?: () => void | Promise<void>;
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

  // CRITICAL FIX: Use in-memory storage for authentication
  // Without this, the authentication result is discarded and subsequent requests fail
  const storage = new MemoryStorage();

  // Create client with custom storage (don't auto-connect, we'll connect manually)
  const client = createClient(daemonUrl, false, {
    verbose: DEBUG_FEATHERS_CLIENT, // Log connection status for debugging
    // Executors may run for much longer than common proxy/websocket connection
    // caps (for example, 15-minute ingress/LB limits). A short retry budget
    // turns a recoverable transport rotation into a permanent daemon
    // disconnect: heartbeats stop, terminal task patches are lost, and the
    // daemon eventually marks the task failed via stale heartbeat/onExit
    // safety nets. Match the browser client and keep retrying for the task's
    // lifetime; the existing reconnect handler below re-authenticates the
    // socket after each successful reconnect.
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    authStorage: storage,
  });

  // Keep the executor JWT available for daemon endpoints that need an explicit
  // task-scoped proof. Socket.io auth can preserve the session creator user
  // while dropping custom JWT claims from subsequent service params.
  (client as AgorClient & { executorSessionToken?: string }).executorSessionToken = sessionToken;

  let serverDisconnectReconnectAttempts = 0;
  let serverDisconnectAuthFailures = 0;
  let serverDisconnectReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const resetServerDisconnectRecovery = () => {
    serverDisconnectReconnectAttempts = 0;
    serverDisconnectAuthFailures = 0;
    if (serverDisconnectReconnectTimer) {
      clearTimeout(serverDisconnectReconnectTimer);
      serverDisconnectReconnectTimer = undefined;
    }
  };

  let reauthenticating = false;
  const reauthenticateSocket = async (label: string): Promise<boolean> => {
    if (reauthenticating) return true;
    reauthenticating = true;
    try {
      // Try reAuthenticate first — uses stored credentials from MemoryStorage
      await client.reAuthenticate(true);
      console.log(`[executor] Re-authenticated successfully after ${label}`);
      resetServerDisconnectRecovery();
      await hooks?.onReauthenticated?.();
      return true;
    } catch {
      // Fallback: authenticate with raw JWT if storage-based re-auth fails
      try {
        await client.authenticate({
          strategy: 'jwt',
          accessToken: sessionToken,
        });
        console.log(`[executor] Re-authenticated with JWT fallback after ${label}`);
        resetServerDisconnectRecovery();
        await hooks?.onReauthenticated?.();
        return true;
      } catch (error) {
        console.error(`[executor] Re-authentication failed after ${label}:`, error);
        return false;
      }
    } finally {
      reauthenticating = false;
    }
  };

  const scheduleServerDisconnectReconnect = () => {
    if (serverDisconnectReconnectTimer) return;

    if (serverDisconnectReconnectAttempts >= SERVER_DISCONNECT_RECONNECT_MAX_ATTEMPTS) {
      logSocketEvent(
        'server_disconnect_reconnect_abandoned',
        `after ${serverDisconnectReconnectAttempts} attempts`
      );
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
      client.io.once('connect', async () => {
        const reauthenticated = await reauthenticateSocket('server disconnect reconnect');
        if (reauthenticated) return;

        serverDisconnectAuthFailures += 1;
        if (serverDisconnectAuthFailures >= SERVER_DISCONNECT_RECONNECT_MAX_AUTH_FAILURES) {
          logSocketEvent(
            'server_disconnect_reconnect_auth_abandoned',
            `after ${serverDisconnectAuthFailures} auth failures`
          );
          client.io.disconnect();
          return;
        }

        client.io.disconnect();
        scheduleServerDisconnectReconnect();
      });
      client.io.connect();
    }, delayMs);
  };

  // Connect the socket
  client.io.on('disconnect', (reason: string) => {
    logSocketEvent('disconnected', reason);

    if (reason === 'io server disconnect') {
      // Socket.IO intentionally disables automatic reconnect after a server-
      // initiated namespace disconnect. In practice, long executor tasks can
      // see this at the same ~15-minute boundary as proxy transport rotation.
      // Treat it as recoverable for executor lifetimes and explicitly reopen
      // the socket; the one-shot connect handler below re-authenticates the new
      // socket because Manager "reconnect" is not emitted for this path.
      scheduleServerDisconnectReconnect();
    }
  });

  client.io.on('connect_error', (error: Error) => {
    logSocketEvent('connect_error', error);
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

  // Wait for connection
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

  feathersClientDebug('[executor] Connected to daemon via Feathers client');

  // Authenticate with session token (which is now a JWT!)
  // This uses the standard JWT strategy - no custom strategy needed
  // Session tokens are JWTs containing { sub: userId, sessionId: sessionId }
  await client.authenticate({
    strategy: 'jwt',
    accessToken: sessionToken,
  });

  feathersClientDebug('[executor] Authenticated with session token (JWT)');

  // Re-authenticate automatically on socket reconnect
  // When socket.io reconnects after a transport error, the new socket is unauthenticated.
  // Without this, all subsequent API calls fail with "NotAuthenticated" and the executor crashes.
  // This is critical for long-running SDK turns (Codex, Gemini) where transient network hiccups
  // can cause socket disconnects mid-execution.
  // NOTE: 'reconnect' is a Manager event, not a Socket event.
  // client.io is the Socket; client.io.io is the Manager.
  client.io.io.on('reconnect', async (attemptNumber: number) => {
    logSocketEvent('reconnected', `attempt ${attemptNumber}; re-authenticating`);
    await reauthenticateSocket('reconnect');
  });

  return client;
}

/**
 * Create Feathers client (alias for createExecutorClient for backward compatibility)
 */
export const createFeathersClient = createExecutorClient;
