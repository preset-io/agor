/**
 * React hook for Agor daemon client connection
 *
 * Manages FeathersJS client lifecycle with React effects
 */

import type { AgorClient } from '@agor-live/client';
import { createClient, createRestClient } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure, isTenantRestrictedError } from '../utils/authErrors';
import {
  markAuthenticationUnrecoverable,
  RefreshUnrecoverableError,
  refreshTokensSingleFlight,
} from '../utils/singleFlightRefresh';
import { getStoredRefreshToken } from '../utils/tokenRefresh';
import { announceSessionStreamsCapability } from './sessionStreamsCapability';

interface UseAgorClientResult {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  /** Monotonic generation of successful authenticated socket handshakes. */
  authGeneration: number;
  /** The daemon has closed this tenant to ordinary access. */
  tenantRestricted: boolean;
  error: string | null;
  retryConnection: () => void;
}

/**
 * Re-probe schedule while the workspace is suspended: 30s, 1m, 2m, 4m, then a
 * 5m ceiling.
 *
 * The first probe is short because the common case is a short hold that an
 * administrator clears in minutes, and the acceptance contract is that release
 * restores the workspace without a manual refresh. The ceiling exists because
 * an unattended suspended tab may sit open for days: at 5 minutes a whole
 * suspended team costs the daemon one rejected handshake per tab per 5 minutes
 * instead of one per second. No jitter — a probe is a single handshake that the
 * daemon rejects before any tenant work, so spreading them buys nothing that
 * would justify making the recovery window non-deterministic.
 */
export const TENANT_RESTRICTION_PROBE_DELAYS_MS = [
  30_000, 60_000, 120_000, 240_000, 300_000,
] as const;

export function tenantRestrictionProbeDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), TENANT_RESTRICTION_PROBE_DELAYS_MS.length - 1);
  return TENANT_RESTRICTION_PROBE_DELAYS_MS[index];
}

interface UseAgorClientOptions {
  url?: string;
  accessToken?: string | null;
  /** Identity of the authenticated authority represented by accessToken. */
  authorityGeneration: number;
}

interface BoundAgorClient {
  client: AgorClient;
  url: string;
  authorityGeneration: number;
  accessTokenRef: { current: string | null | undefined };
}

/**
 * Create and manage Agor daemon client connection
 *
 * @param options - Connection options (url, accessToken)
 * @returns Client instance, connection state, and error
 */
export function useAgorClient(options: UseAgorClientOptions): UseAgorClientResult {
  const { url = getDaemonUrl(), accessToken, authorityGeneration } = options;
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(!!accessToken);
  const [authGeneration, setAuthGeneration] = useState(0);
  const [tenantRestricted, setTenantRestricted] = useState(false);
  const authGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const clientBindingRef = useRef<BoundAgorClient | null>(null);
  const hasToken = !!accessToken;

  // A render for a new authenticated authority must never expose the old
  // client's socket while waiting for effect cleanup. Only a client created
  // for the exact daemon URL + authority generation is render-visible.
  const currentBinding = clientBindingRef.current;
  const visibleBinding =
    hasToken &&
    currentBinding?.url === url &&
    currentBinding.authorityGeneration === authorityGeneration
      ? currentBinding
      : null;

  // Routine token refresh keeps the same authority and socket. Store the new
  // credential for its next natural reconnect, but never transfer a token to
  // a binding created for a different URL or authority generation.
  useEffect(() => {
    const binding = clientBindingRef.current;
    if (
      binding?.url === url &&
      binding.authorityGeneration === authorityGeneration &&
      accessToken
    ) {
      binding.accessTokenRef.current = accessToken;
    }
  }, [url, authorityGeneration, accessToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: token value changes update the credential ref only when URL+authorityGeneration still match; rebuilding would disconnect a healthy same-authority socket
  useEffect(() => {
    let mounted = true;
    let client: AgorClient | null = null;
    const connectionAccessTokenRef = { current: accessToken };
    let binding: BoundAgorClient | null = null;
    let hasConnectedOnce = false; // Track if we've ever connected successfully

    // Bookkeeping for the manual reconnect path used on 'io server disconnect'.
    // socket.io does NOT auto-reconnect for that reason, so we kick it
    // ourselves — but without backoff+cap the loop can run at network speed
    // if the server keeps closing the socket (e.g. auth failures, crash loop,
    // config mismatch). Reset on any successful connect.
    let manualReconnectAttempts = 0;
    let manualReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_MANUAL_RECONNECT_ATTEMPTS = 10;
    const clearManualReconnectTimer = () => {
      if (manualReconnectTimer !== null) {
        clearTimeout(manualReconnectTimer);
        manualReconnectTimer = null;
      }
    };

    // Grace period before flipping `connected` to false on a disconnect.
    // Most reconnects (tsx watch reload, brief network blip, or recovered
    // rejected handshake) finish well under 1s. Flipping `connected` immediately makes
    // every `useConnectionDisabled` consumer disable — buttons, forms,
    // inline inputs — producing a UI flicker. Instead, fire `connecting:true`
    // immediately for the navbar status tag, and only flip `connected` if
    // the reconnect hasn't finished within DISCONNECT_GRACE_MS. If we
    // reconnect inside the window, consumers never see a disabled frame.
    const DISCONNECT_GRACE_MS = 1500;
    let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDisconnectGrace = () => {
      if (disconnectGraceTimer !== null) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
    };
    const scheduleDisconnectedFlip = () => {
      if (disconnectGraceTimer !== null) return; // already pending
      disconnectGraceTimer = setTimeout(() => {
        disconnectGraceTimer = null;
        if (!mounted) return;
        setConnected(false);
      }, DISCONNECT_GRACE_MS);
    };

    // Suspended-workspace state. `restricted` is the effect-local mirror of the
    // rendered flag so socket callbacks can branch without a stale closure.
    let restricted = false;
    let restrictionProbes = 0;
    let restrictionProbeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRestrictionProbeTimer = () => {
      if (restrictionProbeTimer !== null) {
        clearTimeout(restrictionProbeTimer);
        restrictionProbeTimer = null;
      }
    };

    /**
     * Enter (or stay in) the suspended state and stop reconnecting.
     *
     * Socket.IO's own reconnection would keep retrying every 1–5s forever, and
     * the manual 'io server disconnect' path would race it. Both are wrong for
     * a decision the daemon will hold until an operator changes it, so the
     * socket is closed and only the slow probe reopens it.
     */
    const enterTenantRestricted = () => {
      if (!mounted) return;
      restricted = true;
      setTenantRestricted(true);
      setConnecting(false);
      clearDisconnectGrace();
      setConnected(false);
      // The suspended screen is the message; a connection banner would only
      // contradict it.
      setError(null);
      clearManualReconnectTimer();
      manualReconnectAttempts = 0;
      client?.io.disconnect();

      clearRestrictionProbeTimer();
      const delay = tenantRestrictionProbeDelay(restrictionProbes);
      restrictionProbes += 1;
      restrictionProbeTimer = setTimeout(() => {
        restrictionProbeTimer = null;
        if (!mounted || !restricted) return;
        // One handshake. Success clears the state in the `connect` handler;
        // any rejection lands back here and schedules the next, longer probe.
        client?.io.connect();
      }, delay);
    };

    let authenticatedReconnect: Promise<void> | null = null;
    const reconnectWithAuthenticatedHandshake = (nextAccessToken?: string): Promise<void> => {
      if (nextAccessToken) connectionAccessTokenRef.current = nextAccessToken;
      if (authenticatedReconnect) return authenticatedReconnect;
      if (!client) return Promise.reject(new Error('Socket client is unavailable'));

      const socket = client.io;
      authenticatedReconnect = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', handleConnect);
          socket.off('connect_error', handleConnectError);
        };
        const handleConnect = () => {
          cleanup();
          resolve();
        };
        const handleConnectError = (connectError: Error) => {
          cleanup();
          reject(connectError);
        };
        socket.once('connect', handleConnect);
        socket.once('connect_error', handleConnectError);
        if (socket.connected) socket.disconnect();
        socket.connect();
      }).finally(() => {
        authenticatedReconnect = null;
      });
      return authenticatedReconnect;
    };

    // A namespace middleware rejection does not produce a connected socket,
    // so it cannot refresh through the Socket.IO Feathers transport. Recover
    // an expired handshake credential over REST, then reopen the same client
    // with the rotated token. Transport reconnects remain automatic; only the
    // old post-connect Feathers reauthentication transition is gone.
    let handshakeAuthRecovery: Promise<void> | null = null;
    const recoverRejectedHandshake = (connectError: unknown): Promise<void> => {
      if (!isDefiniteAuthFailure(connectError)) return Promise.reject(connectError);
      if (handshakeAuthRecovery) return handshakeAuthRecovery;

      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        return Promise.reject(markAuthenticationUnrecoverable(connectError));
      }

      handshakeAuthRecovery = createRestClient(url)
        .then((restClient) => refreshTokensSingleFlight(restClient, refreshToken))
        .then(async (result) => {
          try {
            await reconnectWithAuthenticatedHandshake(result.accessToken);
          } catch (error) {
            if (isDefiniteAuthFailure(error)) {
              throw markAuthenticationUnrecoverable(error);
            }
            throw error;
          }
        })
        .finally(() => {
          handshakeAuthRecovery = null;
        });
      return handshakeAuthRecovery;
    };

    async function connect() {
      // Don't create client if no access token. `hasToken` is the effect-level
      // snapshot (also a dep, so a later login rebuilds the effect); we still
      // read the value from the ref below in case it rotated during the async
      // connect path.
      if (!hasToken) {
        setConnecting(false);
        setConnected(false);
        setError(null);
        clientBindingRef.current = null;
        return;
      }

      // Reset connected state when starting a new connection attempt
      // This prevents stale "connected: true" state during token transitions
      setConnected(false);
      setConnecting(true);
      setError(null);

      // Create client (autoConnect: false, so we control connection timing)
      const socketClient = createClient(url, false, {
        socketAuthentication: { accessToken: () => connectionAccessTokenRef.current },
      });
      client = socketClient;
      binding = {
        client: socketClient,
        url,
        authorityGeneration,
        accessTokenRef: connectionAccessTokenRef,
      };
      clientBindingRef.current = binding;

      // Store client globally for Vite HMR cleanup
      if (typeof window !== 'undefined') {
        (window as unknown as { __agorClient: AgorClient }).__agorClient = socketClient;
      }

      // Setup socket event listeners BEFORE connecting
      // Single client-side chokepoint for service calls: any Feathers request
      // the daemon rejects with the restriction code flips the app into the
      // suspended state, without waiting for the socket to be retired. The hook
      // only observes — the rejection still reaches its caller unchanged.
      socketClient.hooks({
        error: [
          (context: { error?: unknown }) => {
            if (isTenantRestrictedError(context.error)) enterTenantRestricted();
          },
        ],
      });

      socketClient.io.on('connect', () => {
        if (!mounted) return;
        hasConnectedOnce = true;
        manualReconnectAttempts = 0;
        clearManualReconnectTimer();
        clearDisconnectGrace();
        // An accepted handshake is the daemon's answer that the tenant is open
        // again; nothing else clears the suspended state.
        restricted = false;
        restrictionProbes = 0;
        clearRestrictionProbeTimer();
        setTenantRestricted(false);
        // Socket.IO emits `connect` only after the daemon has verified the
        // handshake and installed immutable user/tenant authority.
        announceSessionStreamsCapability(socketClient);
        const previousGeneration = authGenerationRef.current;
        const nextGeneration = previousGeneration + 1;
        authGenerationRef.current = nextGeneration;
        setAuthGeneration(nextGeneration);
        setConnected(true);
        setConnecting(false);
        setError(null);
      });

      socketClient.io.on('disconnect', (reason) => {
        if (!mounted) return;
        // Our own close while suspended: the probe timer owns reconnection.
        if (restricted) {
          clearDisconnectGrace();
          setConnected(false);
          return;
        }
        // If we've never been connected (initial-load failure), flip
        // immediately — no "reconnect" to wait for. Otherwise defer the
        // flip via the grace timer so quick reconnects don't flicker the
        // UI; the navbar still shows "Reconnecting" via connecting=true.
        if (hasConnectedOnce) {
          scheduleDisconnectedFlip();
        } else {
          setConnected(false);
        }

        // Reason matters here. Per socket.io docs:
        //   - 'io server disconnect' fires when the server explicitly closed
        //     the socket (e.g. graceful shutdown calling io.close()). The
        //     client will NOT auto-reconnect — we have to kick it manually.
        //     This was the bug: tsx watch + production graceful restarts both
        //     hit this path, and the UI got stuck on "Disconnected" until the
        //     user clicked retry.
        //   - 'transport close' / 'transport error' / 'ping timeout' fire on
        //     network-level drops (container crash, wifi flap, etc.). Socket.io
        //     handles auto-reconnect for these.
        // In both auto-reconnect paths we flip connecting=true so the UI shows
        // "Reconnecting" immediately rather than flashing "Disconnected" for
        // the gap before the first connect_error fires.
        if (reason === 'io server disconnect') {
          // Manual reconnect with exponential backoff + cap. Previously we
          // called `client.io.connect()` immediately on every disconnect;
          // when the server repeatedly closed the socket (auth rejection,
          // crash loop, server-side kick) this created a tight reconnect
          // loop at network speed and a page refresh was the only way out.
          if (manualReconnectAttempts >= MAX_MANUAL_RECONNECT_ATTEMPTS) {
            setConnecting(false);
            // Give-up path — flip connected immediately; the grace period
            // is only for quick reconnects we expect to recover from.
            clearDisconnectGrace();
            setConnected(false);
            setError('Lost connection to daemon after multiple attempts. Please reload the page.');
            return;
          }
          setConnecting(true);
          const attempt = manualReconnectAttempts++;
          // 500ms, 1s, 2s, 4s, 8s, 16s, 30s cap.
          const delay = Math.min(500 * 2 ** attempt, 30_000);
          clearManualReconnectTimer();
          manualReconnectTimer = setTimeout(() => {
            manualReconnectTimer = null;
            if (!mounted) return;
            socketClient.io.connect();
          }, delay);
        } else if (
          reason === 'transport close' ||
          reason === 'transport error' ||
          reason === 'ping timeout'
        ) {
          setConnecting(true);
        }
      });

      socketClient.io.on('connect_error', (err: Error) => {
        if (mounted) {
          if (isTenantRestrictedError(err)) {
            enterTenantRestricted();
            return;
          }
          // Credential recovery still runs while suspended, and is reached only
          // after the restriction is lifted: the daemon checks tenant admission
          // before the credential, so a restricted tenant always answers with
          // the code above. On release, a probe whose stale credential is
          // rejected recovers or fails over to sign-in instead of leaving the
          // member parked on a suspended screen for a workspace that is open.
          if (isDefiniteAuthFailure(err)) {
            setConnecting(true);
            recoverRejectedHandshake(err).catch((recoveryError) => {
              if (!mounted) return;
              if (recoveryError instanceof RefreshUnrecoverableError) {
                setError('Authentication could not be restored. Please sign in again.');
              } else {
                console.error('Failed to recover rejected socket handshake:', recoveryError);
                setError('Unable to reconnect to the daemon. Please try again.');
              }
              setConnecting(false);
              clearDisconnectGrace();
              setConnected(false);
            });
            return;
          }
          // Any other probe failure (daemon restarting, network down) keeps the
          // suspended state and the slow cadence rather than falling back into
          // Socket.IO's fast retry: the last authoritative answer is still
          // "restricted", and only an accepted handshake may overturn it.
          if (restricted) {
            enterTenantRestricted();
            return;
          }
          // Only show error on initial connection failure, not during reconnection attempts
          // If we've connected before, keep showing "reconnecting" state instead of error
          if (!hasConnectedOnce) {
            setError('Failed to connect to Agor daemon');
            setConnecting(false);
            setConnected(false);
          } else {
            // During reconnection, keep connecting=true so UI shows reconnecting indicator
            setConnecting(true);
            setConnected(false);
            // Don't set error - socket.io will keep trying
          }
        }
      });

      // Now manually connect the socket
      socketClient.io.connect();

      // A successful `connect` means the handshake has already authenticated.
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 5000);

          if (socketClient.io.connected) {
            clearTimeout(timeout);
            resolve();
            return;
          }

          socketClient.io.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });

          socketClient.io.once('connect_error', (err) => {
            clearTimeout(timeout);
            // The persistent handler above already entered the suspended state.
            // Settle quietly so the initial load does not also raise a
            // "daemon is not running" error over the suspended screen.
            if (isTenantRestrictedError(err) || restricted) {
              resolve();
              return;
            }
            if (isDefiniteAuthFailure(err)) {
              recoverRejectedHandshake(err).then(resolve, reject);
            } else {
              reject(err);
            }
          });
        });
      } catch (connectError) {
        if (mounted && !restricted) {
          setError(
            connectError instanceof RefreshUnrecoverableError
              ? 'Authentication could not be restored. Please sign in again.'
              : 'Failed to connect to Agor daemon'
          );
          setConnecting(false);
          setConnected(false);
        }
        return;
      }
    }

    connect();

    // Cleanup on unmount
    return () => {
      mounted = false;
      clearManualReconnectTimer();
      clearDisconnectGrace();
      clearRestrictionProbeTimer();
      if (client?.io) {
        // Remove all listeners to prevent memory leaks
        client.io.removeAllListeners();
        // Disconnect gracefully (close is more forceful than disconnect)
        client.io.close();
      }
      // Clear global reference
      if (
        typeof window !== 'undefined' &&
        (window as unknown as { __agorClient?: AgorClient }).__agorClient === client
      ) {
        delete (window as unknown as { __agorClient?: AgorClient }).__agorClient;
      }
      if (clientBindingRef.current === binding) {
        clientBindingRef.current = null;
      }
    };
    // The dep list deliberately uses `hasToken` (presence), not the token
    // value itself. Rebuilds happen on authority replacement, login/logout,
    // and URL changes; same-authority token refresh updates only the binding's
    // next-handshake credential.
  }, [url, hasToken, authorityGeneration]);

  /**
   * Manually retry connection
   * Useful when auto-reconnect fails or user wants to force reconnect
   */
  const retryConnection = () => {
    const client = visibleBinding?.client;
    if (!client?.io) return;

    // If already connected, disconnect first
    if (client.io.connected) {
      client.io.disconnect();
    }

    // Trigger reconnection
    setConnecting(true);
    setError(null);
    client.io.connect();
  };

  return {
    client: visibleBinding?.client ?? null,
    connected: !!visibleBinding && connected,
    // A suspended workspace is not "reconnecting": the socket is closed on
    // purpose and the suspended screen, not a connection banner, owns the UI.
    connecting: hasToken && !tenantRestricted ? !visibleBinding || connecting : false,
    authGeneration,
    tenantRestricted: !!visibleBinding && tenantRestricted,
    error: hasToken && !visibleBinding ? null : error,
    retryConnection,
  };
}
