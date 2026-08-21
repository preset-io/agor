/**
 * React hook for Agor daemon client connection
 *
 * Manages FeathersJS client lifecycle with React effects
 */

import type { AgorClient } from '@agor-live/client';
import { createClient, createRestClient } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure } from '../utils/authErrors';
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
  error: string | null;
  retryConnection: () => void;
}

interface UseAgorClientOptions {
  url?: string;
  accessToken?: string | null;
  /** Identity of the authenticated authority represented by accessToken. */
  authorityGeneration: number;
  /** Runs synchronously before a successful socket generation is published. */
  onBeforeAuthGenerationChange?: (previousGeneration: number, nextGeneration: number) => void;
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
  const {
    url = getDaemonUrl(),
    accessToken,
    authorityGeneration,
    onBeforeAuthGenerationChange,
  } = options;
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(!!accessToken);
  const [authGeneration, setAuthGeneration] = useState(0);
  const authGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const clientBindingRef = useRef<BoundAgorClient | null>(null);
  const beforeAuthGenerationChangeRef = useRef(onBeforeAuthGenerationChange);
  beforeAuthGenerationChangeRef.current = onBeforeAuthGenerationChange;
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
      socketClient.io.on('connect', () => {
        if (!mounted) return;
        hasConnectedOnce = true;
        manualReconnectAttempts = 0;
        clearManualReconnectTimer();
        clearDisconnectGrace();
        // Socket.IO emits `connect` only after the daemon has verified the
        // handshake and installed immutable user/tenant authority.
        announceSessionStreamsCapability(socketClient);
        const previousGeneration = authGenerationRef.current;
        const nextGeneration = previousGeneration + 1;
        // Discard caller-private handoffs before routed children can render
        // against the newly authenticated socket generation.
        beforeAuthGenerationChangeRef.current?.(previousGeneration, nextGeneration);
        authGenerationRef.current = nextGeneration;
        setAuthGeneration(nextGeneration);
        setConnected(true);
        setConnecting(false);
        setError(null);
      });

      socketClient.io.on('disconnect', (reason) => {
        if (!mounted) return;
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
          // Only show error on initial connection failure, not during reconnection attempts
          // If we've connected before, keep showing "reconnecting" state instead of error
          if (!hasConnectedOnce) {
            setError('Daemon is not running. Start it with: cd apps/agor-daemon && pnpm dev');
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
            if (isDefiniteAuthFailure(err)) {
              recoverRejectedHandshake(err).then(resolve, reject);
            } else {
              reject(err);
            }
          });
        });
      } catch (connectError) {
        if (mounted) {
          setError(
            connectError instanceof RefreshUnrecoverableError
              ? 'Authentication could not be restored. Please sign in again.'
              : 'Failed to connect to daemon. Make sure it is running on :3030'
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
    connecting: hasToken ? !visibleBinding || connecting : false,
    authGeneration,
    error: hasToken && !visibleBinding ? null : error,
    retryConnection,
  };
}
