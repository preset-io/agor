/**
 * React hook for Agor daemon client connection
 *
 * Manages FeathersJS client lifecycle with React effects
 */

import type { AgorClient } from '@agor-live/client';
import { createClient, createRestClient } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure, isTransientConnectionError } from '../utils/authErrors';
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
    let resumeManualReconnect: (() => void) | null = null;
    const handleOnline = () => resumeManualReconnect?.();
    window.addEventListener('online', handleOnline);
    let hasConnectedOnce = false; // Track if we've ever connected successfully

    // Bookkeeping for the manual reconnect path used on 'io server disconnect'.
    // socket.io does NOT auto-reconnect for that reason, so we kick it
    // ourselves — but without backoff+cap the loop can run at network speed
    // if the server keeps closing the socket (e.g. auth failures, crash loop,
    // config mismatch). Reset only after a stable connection.
    let manualReconnectAttempts = 0;
    let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStableConnectionTimer = () => {
      if (stableConnectionTimer !== null) clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
    };
    let manualReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_MANUAL_RECONNECT_ATTEMPTS = 10;
    const clearManualReconnectTimer = () => {
      if (manualReconnectTimer !== null) {
        clearTimeout(manualReconnectTimer);
        manualReconnectTimer = null;
      }
    };

    // Presentation grace only: preserve the connected indicator across brief
    // dips. `connecting` closes mutation/authority gates immediately, so no
    // disconnected writes are queued during this window.
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
          if (!mounted) return;
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

    function connect() {
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

      const scheduleManualReconnect = () => {
        if (manualReconnectTimer !== null) return;
        setConnecting(true);
        if (!navigator.onLine) {
          // Do not exhaust the bounded retry budget while the browser knows it
          // is offline. Resume this same client on the next online signal.
          resumeManualReconnect = scheduleManualReconnect;
          return;
        }
        resumeManualReconnect = null;
        // Server disconnects and rejected namespaces do not auto-reconnect.
        // Bound this explicit retry path and retain attempts across flapping.
        if (manualReconnectAttempts >= MAX_MANUAL_RECONNECT_ATTEMPTS) {
          setConnecting(false);
          // Give-up path — flip connected immediately; the grace period
          // is only for quick reconnects we expect to recover from.
          clearDisconnectGrace();
          setConnected(false);
          setError(
            'Lost connection to daemon after multiple attempts. Please retry the connection.'
          );
          return;
        }
        setConnecting(true);
        const attempt = manualReconnectAttempts++;
        // Exponential ceilings: 500ms → 30s; jitter in [50%, 100%) spreads retries.
        const delay = Math.min(500 * 2 ** attempt, 30_000) * (0.5 + Math.random() * 0.5);
        clearManualReconnectTimer();
        manualReconnectTimer = setTimeout(() => {
          manualReconnectTimer = null;
          if (!mounted) return;
          if (!navigator.onLine) {
            manualReconnectAttempts -= 1;
            resumeManualReconnect = scheduleManualReconnect;
            return;
          }
          socketClient.io.connect();
        }, delay);
      };

      // Setup socket event listeners BEFORE connecting
      socketClient.io.on('connect', () => {
        if (!mounted) return;
        hasConnectedOnce = true;
        resumeManualReconnect = null;
        // A brief handshake followed by another server kick is not recovery.
        // Reset backoff only after a sustained connection, not every connect.
        clearStableConnectionTimer();
        stableConnectionTimer = setTimeout(() => {
          manualReconnectAttempts = 0;
          stableConnectionTimer = null;
        }, 30_000);
        clearManualReconnectTimer();
        clearDisconnectGrace();
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
        clearStableConnectionTimer();
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
          scheduleManualReconnect();
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
              if (isTransientConnectionError(recoveryError)) {
                // Namespace rejection disables Socket.IO's automatic retries.
                // A failed REST refresh must therefore schedule its own retry.
                scheduleManualReconnect();
                return;
              }
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
            setError('Failed to connect to Agor daemon');
            setConnecting(false);
            setConnected(false);
          } else {
            // During reconnection, keep connecting=true so UI shows reconnecting indicator
            setConnecting(true);
            scheduleDisconnectedFlip();
            // Don't set error - socket.io will keep trying
          }
        }
      });

      // Now manually connect the socket
      socketClient.io.connect();
    }

    connect();

    // Cleanup on unmount
    return () => {
      mounted = false;
      window.removeEventListener('online', handleOnline);
      resumeManualReconnect = null;
      clearManualReconnectTimer();
      clearStableConnectionTimer();
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
